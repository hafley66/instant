//! Boop Search: FTS5 side index (state dir `boop-search.db`) over user and
//! assistant turns; a LIKE scan of the 1.1 GB `said` column took 40 s.
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const INDEX_FILE: &str = "boop-search.db";
const SESSIONS_PER_TX: usize = 200;
const SAID_CAP_CHARS: usize = 20_000;
const SNIPPET_RADIUS: usize = 100;

/// Bytes a SQLite URI filename cannot carry raw; `/` passes through.
const URI_PATH: &AsciiSet = &CONTROLS.add(b' ').add(b'?').add(b'#').add(b'%');

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoopSearchStatus {
    /// Rows in `turn_ref`: user + assistant turns searchable right now.
    pub indexed_turns: i64,
    pub sessions_done: i64,
    pub sessions_total: i64,
    pub building: bool,
    pub error: Option<String>,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoopSearchHit {
    pub session: String,
    pub harness: String,
    pub cwd: Option<String>,
    pub nickname: Option<String>,
    pub turn: i64,
    pub ts: i64,
    pub role: String,
    pub snippet: String,
    /// Full turn text, capped at `SAID_CAP_CHARS` characters.
    pub said: String,
    /// MAX(ts) over the whole session: the chat's last activity.
    pub session_last_ts: i64,
    pub session_turns: i64,
}

#[derive(Default)]
struct SyncState {
    building: bool,
    error: Option<String>,
    sessions_done: i64,
    sessions_total: i64,
    updated_ms: i64,
}

static SYNC: Mutex<SyncState> = Mutex::new(SyncState {
    building: false,
    error: None,
    sessions_done: 0,
    sessions_total: 0,
    updated_ms: 0,
});

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::state_dir(app)?.join(INDEX_FILE))
}

fn boop_uri(path: &Path) -> String {
    format!(
        "file:{}?mode=ro",
        utf8_percent_encode(&path.to_string_lossy(), URI_PATH)
    )
}

/// The index connection with boop.db attached read-only as `boop`.
pub fn open_index(index: &Path, boop: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        index,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| format!("open {}: {error}", index.display()))?;
    conn.busy_timeout(Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS turn_ref (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            turn INTEGER NOT NULL,
            ts INTEGER,
            role TEXT NOT NULL,
            UNIQUE (session_id, turn)
        );
        CREATE INDEX IF NOT EXISTS idx_turn_ref_ts ON turn_ref(ts);
        CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
            said, content='', tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS session_mark (
            session_id INTEGER PRIMARY KEY,
            max_turn INTEGER NOT NULL
        );",
    )
    .map_err(|error| error.to_string())?;
    conn.execute("ATTACH DATABASE ?1 AS boop", params![boop_uri(boop)])
        .map_err(|error| format!("attach {}: {error}", boop.display()))?;
    Ok(conn)
}

pub fn indexed_turns(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM turn_ref", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

/// Sessions whose head turn passed their mark get new user/assistant turns
/// appended; returns sessions visited, `progress` fires per transaction.
pub fn sync_index(
    conn: &Connection,
    mut progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    let heads: Vec<(i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT t.session_id, MAX(t.turn) AS head
                 FROM boop.agent_turn t
                 LEFT JOIN session_mark m ON m.session_id = t.session_id
                 GROUP BY t.session_id
                 HAVING head > COALESCE(MAX(m.max_turn), -1)",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    let total = heads.len() as i64;
    progress(0, total);
    let mut done = 0i64;
    for batch in heads.chunks(SESSIONS_PER_TX) {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| -> Result<(), String> {
            for &(session_id, head) in batch {
                let mark: i64 = conn
                    .query_row(
                        "SELECT COALESCE((SELECT max_turn FROM session_mark WHERE session_id = ?1), -1)",
                        params![session_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                conn.execute(
                    "INSERT OR IGNORE INTO turn_ref (session_id, turn, ts, role)
                     SELECT t.session_id, t.turn, t.ts, r.value
                     FROM boop.agent_turn t
                     JOIN boop.dict_role r ON r.id = t.role_id
                     WHERE t.session_id = ?1 AND t.turn > ?2
                       AND r.value IN ('user', 'assistant')
                       AND t.said IS NOT NULL AND t.said <> ''
                     ORDER BY t.turn",
                    params![session_id, mark],
                )
                .map_err(|error| error.to_string())?;
                conn.execute(
                    "INSERT INTO turn_fts (rowid, said)
                     SELECT ref.id, t.said
                     FROM turn_ref ref
                     JOIN boop.agent_turn t ON t.session_id = ref.session_id AND t.turn = ref.turn
                     WHERE ref.session_id = ?1 AND ref.turn > ?2",
                    params![session_id, mark],
                )
                .map_err(|error| error.to_string())?;
                conn.execute(
                    "INSERT INTO session_mark (session_id, max_turn) VALUES (?1, ?2)
                     ON CONFLICT(session_id) DO UPDATE SET max_turn = excluded.max_turn",
                    params![session_id, head],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => conn
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())?,
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        done += batch.len() as i64;
        progress(done, total);
    }
    Ok(total)
}

/// `breaker rig` -> `"breaker"* "rig"*`: every term a case-insensitive
/// word-prefix, all terms required. Empty when nothing survives.
pub fn fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .map(|term| term.replace('"', ""))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn first_term(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .map(|term| term.replace('"', "").to_lowercase())
        .find(|term| !term.is_empty())
}

/// One-line window around the first case-folded occurrence of `term`, or the
/// head of the text when the fold hid the match.
pub fn snippet(said: &str, term: &str) -> String {
    let lower = said.to_lowercase();
    let at = lower.find(term).unwrap_or(0);
    let mut start = at.saturating_sub(SNIPPET_RADIUS);
    while start > 0 && !said.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + term.len() + SNIPPET_RADIUS).min(said.len());
    while end < said.len() && !said.is_char_boundary(end) {
        end += 1;
    }
    let body = said[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body,
        if end < said.len() { "…" } else { "" }
    )
}

fn cap_chars(text: String) -> String {
    match text.char_indices().nth(SAID_CAP_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text,
    }
}

/// `role` is `all`, `user`, or `assistant`. Newest turn first.
pub fn search(
    conn: &Connection,
    raw: &str,
    role: &str,
    limit: u64,
) -> Result<Vec<BoopSearchHit>, String> {
    let query = fts_query(raw);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let term = first_term(raw).unwrap_or_default();
    let role_filter = if role == "all" { None } else { Some(role.to_string()) };
    let mut stmt = conn
        .prepare(
            "WITH hit AS (
                SELECT r.session_id, r.turn, r.ts, r.role
                FROM turn_fts f
                JOIN turn_ref r ON r.id = f.rowid
                WHERE turn_fts MATCH ?1 AND (?2 IS NULL OR r.role = ?2)
                ORDER BY r.ts DESC
                LIMIT ?3
            )
            SELECT ds.value, dh.value, dc.value, s.nickname,
                   hit.turn, hit.ts, hit.role, t.said,
                   (SELECT MAX(a.ts) FROM boop.agent_turn a WHERE a.session_id = hit.session_id),
                   (SELECT COUNT(*) FROM boop.agent_turn a WHERE a.session_id = hit.session_id)
            FROM hit
            JOIN boop.agent_turn t ON t.session_id = hit.session_id AND t.turn = hit.turn
            JOIN boop.agent_session s ON s.session_id = hit.session_id
            JOIN boop.dict_session ds ON ds.id = hit.session_id
            JOIN boop.dict_harness dh ON dh.id = s.harness_id
            LEFT JOIN boop.dict_cwd dc ON dc.id = s.cwd_id
            ORDER BY hit.ts DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![query, role_filter, limit as i64], |row| {
            let said: String = row.get::<_, Option<String>>(7)?.unwrap_or_default();
            Ok(BoopSearchHit {
                session: row.get(0)?,
                harness: row.get(1)?,
                cwd: row.get(2)?,
                nickname: row.get(3)?,
                turn: row.get(4)?,
                ts: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                role: row.get(6)?,
                snippet: snippet(&said, &term),
                said: cap_chars(said),
                session_last_ts: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                session_turns: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

fn status_of(conn: Option<&Connection>) -> BoopSearchStatus {
    let state = SYNC.lock().unwrap_or_else(|poison| poison.into_inner());
    BoopSearchStatus {
        indexed_turns: conn.and_then(|conn| indexed_turns(conn).ok()).unwrap_or(0),
        sessions_done: state.sessions_done,
        sessions_total: state.sessions_total,
        building: state.building,
        error: state.error.clone(),
        updated_ms: state.updated_ms,
    }
}

fn run_sync(index: PathBuf, boop: PathBuf) {
    let outcome = open_index(&index, &boop).and_then(|conn| {
        sync_index(&conn, |done, total| {
            let mut state = SYNC.lock().unwrap_or_else(|poison| poison.into_inner());
            state.sessions_done = done;
            state.sessions_total = total;
        })
    });
    let mut state = SYNC.lock().unwrap_or_else(|poison| poison.into_inner());
    state.building = false;
    state.updated_ms = now_ms();
    state.error = outcome.err();
}

#[tauri::command]
pub async fn boop_search_status(app: AppHandle) -> Result<BoopSearchStatus, String> {
    let index = index_path(&app)?;
    let boop = crate::boop::boop_db_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_index(&index, &boop).ok();
        Ok(status_of(conn.as_ref()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Start one incremental sync in the background unless one is already
/// running; the status reflects the start immediately.
#[tauri::command]
pub async fn boop_search_sync(app: AppHandle) -> Result<BoopSearchStatus, String> {
    let index = index_path(&app)?;
    let boop = crate::boop::boop_db_path()?;
    let start = {
        let mut state = SYNC.lock().unwrap_or_else(|poison| poison.into_inner());
        if state.building {
            false
        } else {
            state.building = true;
            state.error = None;
            state.sessions_done = 0;
            state.sessions_total = 0;
            true
        }
    };
    if start {
        std::thread::Builder::new()
            .name("boop-search-sync".into())
            .spawn(move || run_sync(index, boop))
            .map_err(|error| error.to_string())?;
    }
    Ok(status_of(None))
}

#[tauri::command]
pub async fn boop_search(
    app: AppHandle,
    query: String,
    role: String,
    limit: Option<u64>,
) -> Result<Vec<BoopSearchHit>, String> {
    let index = index_path(&app)?;
    let boop = crate::boop::boop_db_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_index(&index, &boop)?;
        search(&conn, &query, &role, limit.unwrap_or(500).min(5_000))
    })
    .await
    .map_err(|error| error.to_string())?
}
