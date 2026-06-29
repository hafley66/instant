// Favorited AI turns, persisted to a dedicated SQLite db in app_data_dir so
// they survive even if the harness later deletes the original session. A
// favorite is a full snapshot of one ledger message (identity + cached text),
// keyed by (editor, session_id, message_id). Separate from the harness stores
// (which we only read) — this one is ours to write.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ledger::AiMessage;

pub struct Favorites(pub Mutex<Option<rusqlite::Connection>>);
impl Default for Favorites {
    fn default() -> Self {
        Favorites(Mutex::new(None))
    }
}

#[derive(Serialize, Clone)]
pub struct Fav {
    pub editor: String,
    pub session_id: String,
    pub message_id: String,
    pub role: String,
    pub ts: u64,
    pub seq: u64,
    pub preview: String,
    pub text: String,
    pub locator: String,
    pub cwd: String,
    pub created: u64, // unix ms the favorite was saved
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::state_dir(app)?.join("favorites.db"))
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS favorites (\
    editor TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, \
    role TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER NOT NULL, \
    preview TEXT NOT NULL, text TEXT NOT NULL, locator TEXT NOT NULL, \
    cwd TEXT NOT NULL, created INTEGER NOT NULL, \
    PRIMARY KEY (editor, session_id, message_id))";

/// Open (and create) the favorites db once at startup, stashing the connection
/// in app state. Idempotent table create.
pub fn init(app: &AppHandle) {
    let Ok(path) = db_path(app) else { return };
    let Ok(conn) = rusqlite::Connection::open(path) else {
        return;
    };
    let _ = conn.execute(SCHEMA, []);
    if let Some(state) = app.try_state::<Favorites>() {
        *state.0.lock().unwrap() = Some(conn);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn list(conn: &rusqlite::Connection) -> Vec<Fav> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT editor, session_id, message_id, role, ts, seq, preview, text, locator, cwd, created \
         FROM favorites ORDER BY created DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(Fav {
            editor: r.get(0)?,
            session_id: r.get(1)?,
            message_id: r.get(2)?,
            role: r.get(3)?,
            ts: r.get::<_, i64>(4)? as u64,
            seq: r.get::<_, i64>(5)? as u64,
            preview: r.get(6)?,
            text: r.get(7)?,
            locator: r.get(8)?,
            cwd: r.get(9)?,
            created: r.get::<_, i64>(10)? as u64,
        })
    });
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// Snapshot a ledger message as a favorite (upsert on its identity). Emits
/// "favorites-changed" with the fresh list so any open panel re-renders.
#[tauri::command]
pub fn fav_add(
    app: AppHandle,
    store: State<Favorites>,
    msg: AiMessage,
    cwd: String,
) -> Result<Vec<Fav>, String> {
    let guard = store.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("favorites db not open")?;
    let editor = crate::ledger::editor_tag(&msg.editor);
    conn.execute(
        "INSERT OR REPLACE INTO favorites \
         (editor, session_id, message_id, role, ts, seq, preview, text, locator, cwd, created) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            editor,
            msg.session_id,
            msg.id,
            msg.role,
            msg.ts as i64,
            msg.seq as i64,
            msg.preview,
            msg.text,
            msg.locator,
            cwd,
            now_ms() as i64,
        ],
    )
    .map_err(|e| e.to_string())?;
    let snapshot = list(conn);
    let _ = app.emit("favorites-changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn fav_remove(
    app: AppHandle,
    store: State<Favorites>,
    editor: String,
    session_id: String,
    message_id: String,
) -> Result<Vec<Fav>, String> {
    let guard = store.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("favorites db not open")?;
    conn.execute(
        "DELETE FROM favorites WHERE editor=?1 AND session_id=?2 AND message_id=?3",
        rusqlite::params![editor, session_id, message_id],
    )
    .map_err(|e| e.to_string())?;
    let snapshot = list(conn);
    let _ = app.emit("favorites-changed", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn fav_list(store: State<Favorites>) -> Result<Vec<Fav>, String> {
    let guard = store.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("favorites db not open")?;
    Ok(list(conn))
}
