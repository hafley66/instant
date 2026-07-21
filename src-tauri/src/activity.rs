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

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

// A config-driven extraction rule. instant is the source of truth: the
// extension fetches these from GET /config and reports matches back. The shape
// is stored verbatim (rules.json) and served verbatim; the extension interprets
// mode/schedule, so Rust keeps `schedule` as opaque JSON rather than modeling it.
#[derive(Serialize, Deserialize, Clone)]
pub struct Rule {
    pub id: String,
    pub host: String, // regex, tested against location.host
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub mode: String, // "textnodes" | "selector" | "netcapture"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub captures: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emit: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub schedule: serde_json::Value, // {intervalMin} | "passive" | null
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Process-lifetime rule set, mirrored to rules.json under the app data dir.
/// The ingest server reads it to serve /config; the commands below edit it.
pub struct RulesState {
    pub rules: Mutex<Vec<Rule>>,
    pub path: PathBuf,
    pub revision: AtomicU64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct WatcherStatus {
    pub last_heartbeat: i64,
    pub config_revision: u64,
    pub rules_count: usize,
}

pub struct WatcherState(pub Mutex<WatcherStatus>);

const BUILTIN_USAGE_RULES: [&str; 2] = [
    include_str!("../../src/plugins/metrics/0_claude-usage.rule.json"),
    include_str!("../../src/plugins/metrics/0a_chatgpt-usage.rule.json"),
];

fn reconcile_builtin_schedules(rules: &mut [Rule]) -> usize {
    let schedules: HashMap<String, serde_json::Value> = BUILTIN_USAGE_RULES
        .iter()
        .filter_map(|json| serde_json::from_str::<Rule>(json).ok())
        .map(|rule| (rule.id, rule.schedule))
        .collect();
    let mut changed = 0;
    for rule in rules {
        if rule.schedule.is_null() {
            if let Some(schedule) = schedules.get(&rule.id) {
                rule.schedule = schedule.clone();
                changed += 1;
            }
        }
    }
    changed
}

/// Read rules.json, writing an empty list if absent. A parse error yields an
/// empty list (the extension then falls back to its chrome.storage cache).
pub fn read_rules(path: &Path) -> Vec<Rule> {
    if !path.exists() {
        let _ = std::fs::write(path, "[]");
        return Vec::new();
    }
    let mut rules = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Rule>>(&s).ok())
        .unwrap_or_default();
    if reconcile_builtin_schedules(&mut rules) > 0 {
        let _ = write_rules(path, &rules);
    }
    rules
}

fn write_rules(path: &Path, rules: &[Rule]) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(rules).unwrap_or_else(|_| "[]".into());
    std::fs::write(path, json)
}

// One rule hit reported by the extension: {type:"rulematch", ruleId, url, ts,
// matches:[{field: value}]}. Stored as a source='browser' kind='rulematch' row
// (text = JSON of matches) and emitted on `rule-match` for the Rules panel feed.
#[derive(Deserialize, Serialize, Clone)]
pub struct RuleMatch {
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub matches: Vec<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct WatcherHeartbeat {
    #[serde(default)]
    revision: u64,
    #[serde(default, rename = "rulesCount")]
    rules_count: usize,
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
        .with_header(header(b"Access-Control-Allow-Methods", b"GET, POST, OPTIONS"))
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
                // Rules the extension fetches each tick; instant is the source of
                // truth. `{ "rules": [...] }` (matches the extension's ServerConfig).
                (Method::Get, "/config") => {
                    let rules = app.state::<RulesState>();
                    let list = rules.rules.lock().unwrap();
                    let revision = rules.revision.load(Ordering::Relaxed);
                    let body = serde_json::json!({ "revision": revision, "rules": &*list }).to_string();
                    let resp = Response::from_string(body).with_header(header(
                        b"Content-Type",
                        b"application/json",
                    ));
                    let _ = req.respond(with_cors(resp));
                }
                (Method::Post, "/heartbeat") => {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    match serde_json::from_str::<WatcherHeartbeat>(&body) {
                        Ok(h) => {
                            let status = app.state::<WatcherState>();
                            *status.0.lock().unwrap() = WatcherStatus {
                                last_heartbeat: now_ms(),
                                config_revision: h.revision,
                                rules_count: h.rules_count,
                            };
                            respond(req, 200, "ok");
                        }
                        Err(_) => respond(req, 400, "bad json"),
                    }
                    continue;
                }
                // Recent rule matches, flattened for the sprefa `sh matches()`
                // effect: `[{rule_id,url,field,val,ts}, …]`, newest first. sprefa
                // jsonp-parses this into a `dom_match` rel, symmetric with how
                // ghcacher pulls the GitHub API (path A of the DOM-as-rel plan).
                (Method::Get, "/matches") => {
                    let db = app.state::<ActivityDb>();
                    let body = collect_matches(&db)
                        .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string());
                    let resp = Response::from_string(body).with_header(header(
                        b"Content-Type",
                        b"application/json",
                    ));
                    let _ = req.respond(with_cors(resp));
                }
                (Method::Get, "/diagnostics") => {
                    let db = app.state::<ActivityDb>();
                    let body = collect_network_diagnostics(&db)
                        .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string());
                    let resp = Response::from_string(body).with_header(header(
                        b"Content-Type",
                        b"application/json",
                    ));
                    let _ = req.respond(with_cors(resp));
                }
                (Method::Post, "/ingest") => {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    // Two event families share /ingest: rule matches carry
                    // type:"rulematch"; everything else is an activity-spy event.
                    let is_match = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|s| s == "rulematch"))
                        .unwrap_or(false);
                    if is_match {
                        match serde_json::from_str::<RuleMatch>(&body) {
                            Ok(m) => {
                                // A rule explicitly authorizes its target host.
                                // Observation exclusions still apply to generic
                                // browser activity below, but must not discard
                                // the rule's requested output.
                                let text = serde_json::to_string(&m).unwrap_or_default();
                                let db = app.state::<ActivityDb>();
                                let row = {
                                    let conn = db.0.lock().unwrap();
                                    insert_row(
                                        &conn, now_ms(), "browser", "rulematch", "", &m.url,
                                        &m.rule_id, &text, "",
                                    )
                                };
                                match row {
                                    Ok(event) => {
                                        // The unified timeline row + a dedicated
                                        // event for the Rules panel's live feed.
                                        let _ = app.emit("activity-added", &event);
                                        let _ = app.emit("rule-match", &m);
                                        respond(req, 200, "ok");
                                    }
                                    Err(e) => respond(req, 500, &e.to_string()),
                                }
                            }
                            Err(_) => respond(req, 400, "bad json"),
                        }
                        continue;
                    }
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

/// Flatten recent `rulematch` rows into one JSON object per captured field:
/// `[{rule_id,url,field,val,ts}, …]`, newest first. The stored `text` column is
/// the match's `Vec<HashMap<field,val>>` (see the /ingest rulematch arm); this
/// explodes it so a fixed sprefa jsonp brace pattern can read it. Capped at 500.
fn collect_matches(db: &ActivityDb) -> Result<String, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT ts,url,title,text FROM events WHERE kind='rulematch' \
             ORDER BY ts DESC LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for (ts, url, rule_id, text) in rows {
        let matches: Vec<HashMap<String, serde_json::Value>> = serde_json::from_str::<RuleMatch>(&text)
            .map(|m| m.matches)
            .or_else(|_| serde_json::from_str(&text))
            .unwrap_or_default();
        for m in matches {
            for (field, val) in m {
                out.push(serde_json::json!({
                    "rule_id": rule_id, "url": url,
                    "field": field, "val": val, "ts": ts,
                }));
            }
        }
    }
    Ok(serde_json::Value::Array(out).to_string())
}

/// Return recent extension network diagnostics without response bodies.
fn collect_network_diagnostics(db: &ActivityDb) -> Result<String, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT ts,url,title,text FROM events
             WHERE source='browser' AND (kind LIKE 'netcapture.%' OR kind='rule.trace')
             ORDER BY ts DESC LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "ts": r.get::<_, i64>(0)?,
                "url": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "text": r.get::<_, String>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(serde_json::Value::Array(rows).to_string())
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

/// The rule set the front end edits (Rules panel) and the extension fetches.
#[tauri::command]
pub fn rules_get(state: State<RulesState>) -> Vec<Rule> {
    state.rules.lock().unwrap().clone()
}

/// Replace the rule set, persist to rules.json, return the stored list. The
/// extension picks the change up on its next /config tick (<= 1 min).
#[tauri::command]
pub fn rules_set(state: State<RulesState>, rules: Vec<Rule>) -> Result<Vec<Rule>, String> {
    write_rules(&state.path, &rules).map_err(|e| e.to_string())?;
    *state.rules.lock().unwrap() = rules.clone();
    state.revision.fetch_add(1, Ordering::Relaxed);
    Ok(rules)
}

#[tauri::command]
pub fn activity_rule_matches(state: State<ActivityDb>, limit: Option<i64>) -> Result<Vec<RuleMatch>, String> {
    let cap = limit.unwrap_or(100).clamp(1, 500);
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT title, url, ts, text FROM events
             WHERE source='browser' AND kind='rulematch'
             ORDER BY ts DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cap], |row| {
            let text: String = row.get(3)?;
            Ok(RuleMatch {
                rule_id: row.get(0)?,
                url: row.get(1)?,
                ts: row.get(2)?,
                stream: serde_json::from_str::<RuleMatch>(&text).ok().and_then(|m| m.stream),
                schema: serde_json::from_str::<RuleMatch>(&text).ok().and_then(|m| m.schema),
                matches: serde_json::from_str::<RuleMatch>(&text)
                    .map(|m| m.matches)
                    .or_else(|_| serde_json::from_str(&text))
                    .unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watcher_status(state: State<WatcherState>) -> WatcherStatus {
    state.0.lock().unwrap().clone()
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

    #[test]
    fn adds_builtin_interval_pipeline_without_overwriting_passive() {
        let mut rules: Vec<Rule> = serde_json::from_str(
            r#"[
              {"id":"claude-usage","host":"^claude\\.ai$","mode":"netcapture"},
              {"id":"chatgpt-codex-usage","host":"^chatgpt\\.com$","mode":"netcapture","schedule":"passive"}
            ]"#,
        )
        .unwrap();
        assert_eq!(reconcile_builtin_schedules(&mut rules), 1);
        assert_eq!(rules[0].schedule["source"]["interval"]["periodMs"], 300_000);
        assert_eq!(rules[0].schedule["pipe"][0]["exhaustMap"]["effect"]["op"], "browsingContext.reload");
        assert_eq!(rules[1].schedule, "passive");
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
// todo(security): cap ingest request bodies and define localhost authentication policy
