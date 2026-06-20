// Spy ingest: a localhost HTTP endpoint the browser extension POSTs to, backed
// by a 7-day SQLite ring. Each insert prunes anything older than the window and
// emits `spy-ingested` so the UI table updates live.
//
// Transport: tiny_http on 127.0.0.1:SPY_PORT (chosen over a native-messaging
// host so the extension just fetch()es and it's curl-testable). The server runs
// on its own thread and reaches the shared connection through managed state.

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Response, Server};

pub const SPY_PORT: u16 = 8787;
const RETAIN_DAYS: i64 = 7;

/// Shared SQLite connection. State is Send+Sync via the Mutex; both the commands
/// and the ingest thread lock it.
pub struct SpyDb(pub Mutex<Connection>);

#[derive(Serialize, Clone)]
pub struct SpyEvent {
    id: i64,
    ts: i64, // unix ms
    kind: String, // "nav" | "selection" | "clipboard"
    url: String,
    title: String,
    text: String,
}

// What the extension sends. Everything but `kind` is optional.
#[derive(Deserialize)]
struct Ingest {
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the ring DB and ensure the schema exists.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events(
           id    INTEGER PRIMARY KEY AUTOINCREMENT,
           ts    INTEGER NOT NULL,
           kind  TEXT NOT NULL,
           url   TEXT NOT NULL DEFAULT '',
           title TEXT NOT NULL DEFAULT '',
           text  TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);",
    )?;
    Ok(conn)
}

fn insert(conn: &Connection, ev: &Ingest) -> rusqlite::Result<SpyEvent> {
    let ts = now_ms();
    conn.execute(
        "INSERT INTO events(ts,kind,url,title,text) VALUES(?1,?2,?3,?4,?5)",
        params![ts, ev.kind, ev.url, ev.title, ev.text],
    )?;
    let id = conn.last_insert_rowid();
    // Ring: drop anything past the retention window on every insert.
    let cutoff = ts - RETAIN_DAYS * 24 * 3600 * 1000;
    conn.execute("DELETE FROM events WHERE ts < ?1", params![cutoff])?;
    Ok(SpyEvent {
        id,
        ts,
        kind: ev.kind.clone(),
        url: ev.url.clone(),
        title: ev.title.clone(),
        text: ev.text.clone(),
    })
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

/// Run the ingest server on its own thread until the process exits.
pub fn spawn_server(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match Server::http(("127.0.0.1", SPY_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("spy ingest server failed to bind 127.0.0.1:{SPY_PORT}: {e}");
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
                        Ok(ev) => {
                            let db = app.state::<SpyDb>();
                            let row = {
                                let conn = db.0.lock().unwrap();
                                insert(&conn, &ev)
                            };
                            match row {
                                Ok(event) => {
                                    let _ = app.emit("spy-ingested", &event);
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

/// Most-recent events first, capped at `limit` (default 500).
#[tauri::command]
pub fn spy_events(db: State<SpyDb>, limit: Option<i64>) -> Result<Vec<SpyEvent>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id,ts,kind,url,title,text FROM events ORDER BY ts DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.unwrap_or(500)], |r| {
            Ok(SpyEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                url: r.get(3)?,
                title: r.get(4)?,
                text: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spy_clear(db: State<SpyDb>) -> Result<(), String> {
    db.0.lock()
        .unwrap()
        .execute("DELETE FROM events", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
