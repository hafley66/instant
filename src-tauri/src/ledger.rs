// Unified reader over AI-harness session ledgers on disk, so the UI can browse
// turns and favorite any message regardless of editor. Two on-disk formats are
// collapsed to one (session, message) shape with a stable identity:
//   - claude:   ~/.claude/projects/<cwd '/'->'-'>/<sessionId>.jsonl (append-only
//               NDJSON, one record per line; identity = (sessionId, uuid)).
//   - opencode: ~/.local/share/opencode/opencode.db (SQLite); message(id,
//               session_id, time_created, data-json); identity = (session_id,
//               message.id). Read-only — we never write a harness's own store.
// `harness.rs` already resolves the latest session id per cwd; this reads the
// turns inside one.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// "claude" | "opencode" off the wire; anything else is rejected by the commands.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Claude,
    Opencode,
}

impl Editor {
    fn parse(s: &str) -> Option<Editor> {
        match s {
            "claude" => Some(Editor::Claude),
            "opencode" => Some(Editor::Opencode),
            _ => None,
        }
    }
    fn tag(self) -> &'static str {
        match self {
            Editor::Claude => "claude",
            Editor::Opencode => "opencode",
        }
    }
}

#[derive(Serialize, Clone)]
pub struct AiSession {
    pub editor: Editor,
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub updated: u64, // unix ms of the newest message
    pub path: Option<String>, // jsonl path (claude); None for opencode (db row)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AiMessage {
    pub editor: Editor,
    pub session_id: String,
    pub id: String, // uuid (claude) / message.id (opencode) — stable identity
    pub seq: u64,   // order key: line index (claude) / time_created (opencode)
    pub role: String,
    pub ts: u64, // unix ms
    pub preview: String,
    pub text: String,    // full extracted plain text (for cache/copy)
    pub locator: String, // "claude:<path>#L<n>" | "opencode:#msg=<id>"
}

fn claude_dir(cwd: &str) -> Option<PathBuf> {
    Some(
        home()?
            .join(".claude")
            .join("projects")
            .join(cwd.replace('/', "-")),
    )
}

// Cap a string to `max` chars with an ellipsis. Tool inputs/outputs and thinking
// traces can be huge; the searchable text only needs enough to match the screen.
fn cap(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

// Extracted turn text: `full` is everything the harness rendered (prose +
// thinking + tool calls/results) so a search matches whatever's on screen;
// `display` is just the assistant's prose, used for a clean preview/label.
struct Extracted {
    full: String,
    display: String,
}

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// Flatten a claude `message.content` (string OR array of typed blocks). thinking
// carries its real text; tool_use serializes its input; tool_result its output —
// all into `full`. Only text blocks feed `display`.
fn claude_text(content: &Value) -> Extracted {
    match content {
        Value::String(s) => Extracted {
            full: s.clone(),
            display: s.clone(),
        },
        Value::Array(blocks) => {
            let mut full = String::new();
            let mut display = String::new();
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            full.push_str(t);
                            full.push('\n');
                            display.push_str(t);
                            display.push('\n');
                        }
                    }
                    Some("thinking") => {
                        if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                            full.push_str(&cap(t, 600));
                            full.push('\n');
                        }
                    }
                    Some("tool_use") => {
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                        full.push_str(&format!("[{name}] "));
                        if let Some(input) = b.get("input") {
                            full.push_str(&cap(&input.to_string(), 400));
                        }
                        full.push('\n');
                    }
                    Some("tool_result") => {
                        let t = tool_result_text(b.get("content"));
                        if !t.is_empty() {
                            full.push_str(&cap(&t, 400));
                            full.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Extracted {
                full: full.trim_end().to_string(),
                display: display.trim_end().to_string(),
            }
        }
        _ => Extracted {
            full: String::new(),
            display: String::new(),
        },
    }
}

fn iso_to_ms(s: &str) -> u64 {
    // Avoid a chrono dependency: ledger timestamps are only used for display and
    // ordering (seq is the real order key), so a lenient parse is fine. Fall back
    // to 0 when absent.
    chrono_lite(s).unwrap_or(0)
}

// Minimal RFC3339 → unix ms without a crate. Returns None on any shape mismatch.
fn chrono_lite(s: &str) -> Option<u64> {
    // 2026-06-26T12:17:10.619Z
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let yr: i64 = s.get(0..4)?.parse().ok()?;
    let mo: i64 = s.get(5..7)?.parse().ok()?;
    let da: i64 = s.get(8..10)?.parse().ok()?;
    let hh: i64 = s.get(11..13)?.parse().ok()?;
    let mi: i64 = s.get(14..16)?.parse().ok()?;
    let ss: i64 = s.get(17..19)?.parse().ok()?;
    let ms: i64 = s
        .get(20..23)
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    // days since unix epoch via a civil-from-days algorithm (Howard Hinnant).
    let y = if mo <= 2 { yr - 1 } else { yr };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hh * 3600 + mi * 60 + ss;
    Some((secs * 1000 + ms) as u64)
}

fn preview_of(text: &str) -> String {
    let one = text.replace('\n', " ");
    let trimmed = one.trim();
    if trimmed.chars().count() > 200 {
        trimmed.chars().take(200).collect::<String>() + "…"
    } else {
        trimmed.to_string()
    }
}

// Read every turn from one claude jsonl. `after_seq` skips lines already seen
// (the watcher passes the last line index). Only user/assistant rows become
// messages; system/mode/snapshot lines are skipped but still advance `seq` so
// the line index stays an exact file offset.
fn read_claude(path: &PathBuf, session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let path_str = path.to_string_lossy().to_string();
    let mut out = Vec::new();
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let seq = i as u64;
        if let Some(a) = after_seq {
            if seq <= a {
                continue;
            }
        }
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some(t @ ("user" | "assistant")) => t,
            _ => continue,
        };
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .cloned()
            .unwrap_or(Value::Null);
        let ex = claude_text(&content);
        if ex.full.is_empty() {
            continue;
        }
        // Preview from the prose; fall back to full for tool-only turns.
        let preview = preview_of(if ex.display.is_empty() { &ex.full } else { &ex.display });
        let text = ex.full;
        let id = v
            .get("uuid")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(iso_to_ms)
            .unwrap_or(0);
        out.push(AiMessage {
            editor: Editor::Claude,
            session_id: session_id.to_string(),
            id,
            seq,
            role: role.to_string(),
            ts,
            preview,
            text,
            locator: format!("claude:{path_str}#L{}", seq + 1),
        });
    }
    out
}

fn opencode_db() -> Option<PathBuf> {
    Some(
        home()?
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db"),
    )
}

fn open_opencode() -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        opencode_db()?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

// Pull an opencode message's text from its `part` rows. Each part's `data` is a
// json block: text/reasoning carry a `text` field; a tool part carries its name
// + `state.input` (the command/args) + `state.output`. reasoning + tool feed the
// searchable `full`; only text parts feed `display`.
fn opencode_message_text(conn: &rusqlite::Connection, message_id: &str) -> Extracted {
    let mut full = String::new();
    let mut display = String::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created, id")
    {
        let rows = stmt.query_map([message_id], |row| row.get::<_, String>(0));
        if let Ok(rows) = rows {
            for data in rows.flatten() {
                if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                                full.push_str(t);
                                full.push('\n');
                                display.push_str(t);
                                display.push('\n');
                            }
                        }
                        Some("reasoning") => {
                            if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                                if !t.is_empty() {
                                    full.push_str(&cap(t, 600));
                                    full.push('\n');
                                }
                            }
                        }
                        Some("tool") => {
                            let name = v.get("tool").and_then(|n| n.as_str()).unwrap_or("tool");
                            full.push_str(&format!("[{name}] "));
                            if let Some(input) = v.pointer("/state/input") {
                                full.push_str(&cap(&input.to_string(), 400));
                            }
                            if let Some(out) = v.pointer("/state/output").and_then(|o| o.as_str()) {
                                full.push(' ');
                                full.push_str(&cap(out, 400));
                            }
                            full.push('\n');
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Extracted {
        full: full.trim_end().to_string(),
        display: display.trim_end().to_string(),
    }
}

fn read_opencode(session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
    let Some(conn) = open_opencode() else {
        return Vec::new();
    };
    let after = after_seq.unwrap_or(0) as i64;
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, time_created, data FROM message \
         WHERE session_id = ?1 AND time_created > ?2 \
         ORDER BY time_created, id",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(rusqlite::params![session_id, after], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    for (id, time_created, data) in rows.flatten() {
        let role = serde_json::from_str::<Value>(&data)
            .ok()
            .and_then(|v| v.get("role").and_then(|r| r.as_str()).map(String::from))
            .unwrap_or_else(|| "assistant".to_string());
        let ex = opencode_message_text(&conn, &id);
        if ex.full.is_empty() {
            continue;
        }
        let preview = preview_of(if ex.display.is_empty() { &ex.full } else { &ex.display });
        out.push(AiMessage {
            editor: Editor::Opencode,
            session_id: session_id.to_string(),
            id: id.clone(),
            seq: time_created as u64,
            role,
            ts: time_created as u64,
            preview,
            text: ex.full,
            locator: format!("opencode:#msg={id}"),
        });
    }
    out
}

/// All turns in one session, oldest first. `after_seq` returns only newer turns
/// (the watcher's incremental read).
#[tauri::command]
pub fn read_ai_messages(
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
) -> Result<Vec<AiMessage>, String> {
    match Editor::parse(&editor).ok_or("unknown editor")? {
        Editor::Claude => {
            let dir = claude_dir(&cwd).ok_or("no HOME")?;
            let path = dir.join(format!("{session_id}.jsonl"));
            Ok(read_claude(&path, &session_id, after_seq))
        }
        Editor::Opencode => Ok(read_opencode(&session_id, after_seq)),
    }
}

/// The newest turn in a session (drives "favorite current turn" + the watcher).
#[tauri::command]
pub fn latest_ai_message(
    editor: String,
    session_id: String,
    cwd: String,
) -> Result<Option<AiMessage>, String> {
    let mut msgs = read_ai_messages(editor, session_id, cwd, None)?;
    Ok(msgs.pop())
}

/// Sessions for a cwd (or all, when cwd is None), newest first. Lightweight
/// browse list; reading the turns is a separate call.
#[tauri::command]
pub fn list_ai_sessions(editor: String, cwd: Option<String>) -> Result<Vec<AiSession>, String> {
    match Editor::parse(&editor).ok_or("unknown editor")? {
        Editor::Claude => Ok(list_claude_sessions(cwd)),
        Editor::Opencode => Ok(list_opencode_sessions(cwd)),
    }
}

fn list_claude_sessions(cwd: Option<String>) -> Vec<AiSession> {
    let Some(cwd) = cwd else { return Vec::new() }; // claude is keyed by cwd; no global list
    let Some(dir) = claude_dir(&cwd) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let updated = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // Title = first user turn's preview (cheap: read until the first one).
        let title = read_claude(&path, id, None)
            .into_iter()
            .find(|m| m.role == "user")
            .map(|m| m.preview)
            .unwrap_or_default();
        out.push(AiSession {
            editor: Editor::Claude,
            id: id.to_string(),
            cwd: cwd.clone(),
            title,
            updated,
            path: Some(path.to_string_lossy().to_string()),
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

fn list_opencode_sessions(cwd: Option<String>) -> Vec<AiSession> {
    let Some(conn) = open_opencode() else {
        return Vec::new();
    };
    let (sql, params): (&str, Vec<String>) = match &cwd {
        Some(c) => (
            "SELECT id, directory, title, time_updated FROM session \
             WHERE directory = ?1 AND time_archived IS NULL ORDER BY time_updated DESC",
            vec![c.clone()],
        ),
        None => (
            "SELECT id, directory, title, time_updated FROM session \
             WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 200",
            vec![],
        ),
    };
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let map = |row: &rusqlite::Row| {
        Ok(AiSession {
            editor: Editor::Opencode,
            id: row.get::<_, String>(0)?,
            cwd: row.get::<_, String>(1)?,
            title: row.get::<_, String>(2)?,
            updated: row.get::<_, i64>(3)? as u64,
            path: None,
        })
    };
    let rows = if params.is_empty() {
        stmt.query_map([], map)
    } else {
        stmt.query_map([&params[0]], map)
    };
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

// Re-export the editor tag for the favorites module's identity strings.
pub fn editor_tag(editor: &Editor) -> &'static str {
    editor.tag()
}
