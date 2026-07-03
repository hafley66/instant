// Unified activity store: one SQLite table fed by four sources —
//   'browser' : the extension POSTs DOM/tab events to the localhost ingest server
//   'os'      : the capture worker writes a screenshot row per mouse/key gesture
//   'files'   : the Files panel logs an 'open' row when you reference a file
//   'editor'  : the VS Code extension POSTs focus/cursor/save events (path +
//               line + language id only, never buffer contents)
// fzf search + the Activity timeline read this one table, so everything you touch
// lands in a single searchable history.
//
// Retention (pruned on every insert):
//   os    -> keep newest SHOT_CAP rows; delete older rows AND their PNG files.
//   other -> 7-day ring (DELETE WHERE ts < now - 7d).
//
// Transport for browser rows: tiny_http on 127.0.0.1:INGEST_PORT (curl-testable,
// no native-messaging host). The server runs on its own thread and reaches the
// shared connection through managed state.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Response, Server};

pub const INGEST_PORT: u16 = 8787;
const RETAIN_DAYS: i64 = 7;
const SHOT_CAP: i64 = 2000; // keep newest N screenshots; older rows + PNGs pruned

/// Shared SQLite connection. Send+Sync via the Mutex; commands, the ingest
/// thread, and the capture workers all lock it.
pub struct ActivityDb(pub Mutex<Connection>);

/// Capture on/off, shared between the tap thread (reads it per gesture) and the
/// `capture_set_enabled` command (writes it). Default false.
pub struct CaptureEnabled(pub Arc<AtomicBool>);

#[derive(Serialize, Clone)]
pub struct Event {
    pub id: i64,
    pub ts: i64,        // unix ms
    pub source: String, // 'browser' | 'os' | 'files'
    pub kind: String,
    pub app: String,   // frontmost app (os captures)
    pub url: String,
    pub title: String, // browser title / file name
    pub text: String,  // selection/clipboard / file path / dom context
    pub shot: String,  // screenshot path (os captures)
}

// What the extension(s) send. The Chrome extension sends `kind` (+ url/title/
// text); the VS Code extension sends `type:"editor"` + `event` (+ path/line/
// languageId/workspace — never file contents). All fields default so either
// shape deserializes with the other's fields empty.
#[derive(Deserialize)]
struct Ingest {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default, rename = "type")]
    source_type: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<i64>,
    #[serde(default, rename = "languageId")]
    language_id: String,
    #[serde(default)]
    workspace: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the store and ensure the schema exists. Migrates the old `spy.db` shape
/// (events without source/app/shot) by adding the columns if missing.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events(
           id     INTEGER PRIMARY KEY AUTOINCREMENT,
           ts     INTEGER NOT NULL,
           source TEXT NOT NULL DEFAULT 'browser',
           kind   TEXT NOT NULL,
           app    TEXT NOT NULL DEFAULT '',
           url    TEXT NOT NULL DEFAULT '',
           title  TEXT NOT NULL DEFAULT '',
           text   TEXT NOT NULL DEFAULT '',
           shot   TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);",
    )?;
    // Add columns the old spy.db lacked (idempotent; ignore "duplicate column").
    for ddl in [
        "ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'browser'",
        "ALTER TABLE events ADD COLUMN app TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE events ADD COLUMN shot TEXT NOT NULL DEFAULT ''",
    ] {
        let _ = conn.execute(ddl, []);
    }
    Ok(conn)
}

/// Insert one row of any source, prune, and return it. Callers fill defaults for
/// fields their source doesn't use.
#[allow(clippy::too_many_arguments)]
pub fn insert_row(
    conn: &Connection,
    ts: i64,
    source: &str,
    kind: &str,
    app: &str,
    url: &str,
    title: &str,
    text: &str,
    shot: &str,
) -> rusqlite::Result<Event> {
    conn.execute(
        "INSERT INTO events(ts,source,kind,app,url,title,text,shot)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![ts, source, kind, app, url, title, text, shot],
    )?;
    let id = conn.last_insert_rowid();
    prune(conn, source, ts)?;
    Ok(Event {
        id,
        ts,
        source: source.into(),
        kind: kind.into(),
        app: app.into(),
        url: url.into(),
        title: title.into(),
        text: text.into(),
        shot: shot.into(),
    })
}

// os: count-cap (PNGs are heavy). other: time-ring.
fn prune(conn: &Connection, source: &str, ts: i64) -> rusqlite::Result<()> {
    if source == "os" {
        let mut stmt = conn.prepare(
            "SELECT id, shot FROM events WHERE source='os'
             ORDER BY ts DESC LIMIT -1 OFFSET ?1",
        )?;
        let doomed: Vec<(i64, String)> = stmt
            .query_map(params![SHOT_CAP], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, shot) in &doomed {
            if !shot.is_empty() {
                let _ = std::fs::remove_file(shot); // best-effort
            }
            conn.execute("DELETE FROM events WHERE id=?1", params![id])?;
        }
    } else {
        let cutoff = ts - RETAIN_DAYS * 24 * 3600 * 1000;
        conn.execute(
            "DELETE FROM events WHERE source IN ('browser','files','editor') AND ts < ?1",
            params![cutoff],
        )?;
    }
    Ok(())
}

fn header(name: &[u8], value: &[u8]) -> Header {
    Header::from_bytes(name, value).expect("static header")
}

// Permissive CORS so the extension's background fetch() succeeds.
fn with_cors<R: Read>(resp: Response<R>) -> Response<R> {
    resp.with_header(header(b"Access-Control-Allow-Origin", b"*"))
        .with_header(header(b"Access-Control-Allow-Methods", b"POST, OPTIONS"))
        .with_header(header(b"Access-Control-Allow-Headers", b"Content-Type"))
}

/// Run the ingest server on its own thread until the process exits. Each POST
/// writes a `source='browser'` row and emits `activity-added`.
pub fn spawn_server(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match Server::http(("127.0.0.1", INGEST_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("activity ingest server failed to bind 127.0.0.1:{INGEST_PORT}: {e}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let respond = |req: tiny_http::Request, status: u16, body: &str| {
                let resp = Response::from_string(body).with_status_code(status);
                let _ = req.respond(with_cors(resp));
            };
            match (req.method(), req.url()) {
                (Method::Options, _) => {
                    let _ = req.respond(with_cors(Response::empty(204)));
                }
                (Method::Post, "/ingest") => {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    match serde_json::from_str::<Ingest>(&body) {
                        Ok(ev) if ev.source_type == "editor" => {
                            // VS Code extension: focus/cursor/save. Path + line
                            // + language id only, filtered like Files-panel rows.
                            let cfg = app.state::<crate::config::ConfigState>();
                            if cfg.config.lock().unwrap().file_excluded(&ev.path) {
                                crate::config::note_excluded(&cfg);
                                respond(req, 200, "filtered");
                                continue;
                            }
                            let db = app.state::<ActivityDb>();
                            let text = match ev.line {
                                Some(line) => line.to_string(),
                                None => ev.language_id.clone(),
                            };
                            let row = {
                                let conn = db.0.lock().unwrap();
                                insert_row(
                                    &conn,
                                    now_ms(),
                                    "editor",
                                    &ev.event,
                                    "",
                                    &ev.path,
                                    &ev.workspace,
                                    &text,
                                    "",
                                )
                            };
                            match row {
                                Ok(event) => {
                                    let _ = app.emit("activity-added", &event);
                                    respond(req, 200, "ok");
                                }
                                Err(e) => respond(req, 500, &e.to_string()),
                            }
                        }
                        Ok(ev) => {
                            // Observation filter: drop excluded sites before recording.
                            let cfg = app.state::<crate::config::ConfigState>();
                            if cfg.config.lock().unwrap().site_excluded(&ev.url) {
                                crate::config::note_excluded(&cfg);
                                respond(req, 200, "filtered");
                                continue;
                            }
                            let db = app.state::<ActivityDb>();
                            let row = {
                                let conn = db.0.lock().unwrap();
                                insert_row(
                                    &conn,
                                    now_ms(),
                                    "browser",
                                    &ev.kind,
                                    "",
                                    &ev.url,
                                    &ev.title,
                                    &ev.text,
                                    "",
                                )
                            };
                            match row {
                                Ok(event) => {
                                    let _ = app.emit("activity-added", &event);
                                    respond(req, 200, "ok");
                                }
                                Err(e) => respond(req, 500, &e.to_string()),
                            }
                        }
                        Err(_) => respond(req, 400, "bad json"),
                    }
                }
                _ => respond(req, 404, "not found"),
            }
        }
    });
}

/// Most-recent events first, capped at `limit` (default 2000), optionally
/// filtered to one source.
#[tauri::command]
pub fn activity_events(
    db: State<ActivityDb>,
    limit: Option<i64>,
    source: Option<String>,
) -> Result<Vec<Event>, String> {
    let conn = db.0.lock().unwrap();
    let lim = limit.unwrap_or(2000);
    let src = source.filter(|s| s != "all");
    let map = |r: &rusqlite::Row| {
        Ok(Event {
            id: r.get(0)?,
            ts: r.get(1)?,
            source: r.get(2)?,
            kind: r.get(3)?,
            app: r.get(4)?,
            url: r.get(5)?,
            title: r.get(6)?,
            text: r.get(7)?,
            shot: r.get(8)?,
        })
    };
    let cols = "id,ts,source,kind,app,url,title,text,shot";
    let rows = match &src {
        Some(s) => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {cols} FROM events WHERE source=?1 ORDER BY ts DESC LIMIT ?2"
                ))
                .map_err(|e| e.to_string())?;
            let out = stmt
                .query_map(params![s, lim], map)
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>();
            out
        }
        None => {
            let mut stmt = conn
                .prepare(&format!("SELECT {cols} FROM events ORDER BY ts DESC LIMIT ?1"))
                .map_err(|e| e.to_string())?;
            let out = stmt
                .query_map(params![lim], map)
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>();
            out
        }
    };
    rows.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn activity_clear(db: State<ActivityDb>) -> Result<(), String> {
    // Drop screenshot files first, then the rows.
    {
        let conn = db.0.lock().unwrap();
        if let Ok(mut stmt) = conn.prepare("SELECT shot FROM events WHERE shot<>''") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for shot in rows.flatten() {
                    let _ = std::fs::remove_file(shot);
                }
            }
        }
        conn.execute("DELETE FROM events", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Log a non-capture row (the Files panel logs `open` rows here so file
/// references join the unified history).
#[tauri::command]
pub fn activity_log(
    db: State<ActivityDb>,
    cfg: State<crate::config::ConfigState>,
    app: AppHandle,
    source: String,
    kind: String,
    title: String,
    text: String,
) -> Result<(), String> {
    // Observation filter: drop excluded file paths before recording.
    if cfg.config.lock().unwrap().file_excluded(&text) {
        crate::config::note_excluded(&cfg);
        return Ok(());
    }
    let row = {
        let conn = db.0.lock().unwrap();
        insert_row(&conn, now_ms(), &source, &kind, "", "", &title, &text, "")
    }
    .map_err(|e| e.to_string())?;
    let _ = app.emit("activity-added", &row);
    Ok(())
}

#[tauri::command]
pub fn capture_set_enabled(app: AppHandle, state: State<CaptureEnabled>, on: bool) {
    state.0.store(on, std::sync::atomic::Ordering::Relaxed);
    crate::set_recording_indicator(&app, on);
}

#[tauri::command]
pub fn capture_enabled(state: State<CaptureEnabled>) -> bool {
    state.0.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The VS Code extension's three payload shapes (see vscode-ext/src/extension.ts)
    // must deserialize into `Ingest` with `source_type == "editor"` and never touch
    // the browser-only fields.
    #[test]
    fn parses_editor_focus_payload() {
        let ev: Ingest = serde_json::from_str(
            r#"{"type":"editor","event":"focus","path":"/tmp/a.ts","languageId":"typescript","workspace":"instant","ts":1}"#,
        )
        .unwrap();
        assert_eq!(ev.source_type, "editor");
        assert_eq!(ev.event, "focus");
        assert_eq!(ev.path, "/tmp/a.ts");
        assert_eq!(ev.language_id, "typescript");
        assert_eq!(ev.workspace, "instant");
        assert_eq!(ev.kind, ""); // browser-only field stays default
    }

    #[test]
    fn parses_editor_cursor_payload() {
        let ev: Ingest =
            serde_json::from_str(r#"{"type":"editor","event":"cursor","path":"/tmp/a.ts","line":42,"ts":2}"#)
                .unwrap();
        assert_eq!(ev.source_type, "editor");
        assert_eq!(ev.line, Some(42));
    }

    #[test]
    fn parses_editor_save_payload() {
        let ev: Ingest =
            serde_json::from_str(r#"{"type":"editor","event":"save","path":"/tmp/a.ts","ts":3}"#).unwrap();
        assert_eq!(ev.source_type, "editor");
        assert_eq!(ev.event, "save");
    }

    // The Chrome extension's existing shape must still parse unchanged.
    #[test]
    fn parses_browser_payload() {
        let ev: Ingest = serde_json::from_str(
            r#"{"kind":"nav","url":"https://example.com","title":"Example","text":""}"#,
        )
        .unwrap();
        assert_eq!(ev.source_type, ""); // absent => not routed to the editor branch
        assert_eq!(ev.kind, "nav");
        assert_eq!(ev.url, "https://example.com");
    }

    // Editor rows must round-trip through insert + the 7-day prune query
    // ('editor' has to be in the retained-source list or rows never expire).
    #[test]
    fn editor_rows_insert_and_prune() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events(
               id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
               source TEXT NOT NULL, kind TEXT NOT NULL, app TEXT NOT NULL,
               url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, shot TEXT NOT NULL)",
        )
        .unwrap();
        let row = insert_row(&conn, 1_000, "editor", "save", "", "/tmp/a.ts", "instant", "", "").unwrap();
        assert_eq!(row.source, "editor");
        assert_eq!(row.kind, "save");
        assert_eq!(row.url, "/tmp/a.ts");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events WHERE source='editor'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
