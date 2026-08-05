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

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// Harness ids are stable wire names; storage format differences stay below this
// boundary.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Claude,
    Opencode,
    Codex,
    Kimi,
}

impl Editor {
    fn parse(s: &str) -> Option<Editor> {
        match s {
            "claude" => Some(Editor::Claude),
            "opencode" => Some(Editor::Opencode),
            "codex" => Some(Editor::Codex),
            "kimi" => Some(Editor::Kimi),
            _ => None,
        }
    }
    fn tag(self) -> &'static str {
        match self {
            Editor::Claude => "claude",
            Editor::Opencode => "opencode",
            Editor::Codex => "codex",
            Editor::Kimi => "kimi",
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    pub ts: u64, // unix ms
    pub preview: String,
    pub text: String,    // full extracted plain text (for cache/copy)
    pub locator: String, // "claude:<path>#L<n>" | "opencode:#msg=<id>"
}

/// Discovery only. The UI can offer the exact local install command when CASS
/// is absent, but it never installs or indexes on the user's behalf.
#[derive(Serialize)]
pub struct CassStatus {
    pub available: bool,
    pub path: Option<String>,
}

fn cass_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|dir| dir.join("cass")));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/cass"),
        PathBuf::from("/usr/local/bin/cass"),
        home()?.join(".cargo/bin/cass"),
        home()?.join(".local/bin/cass"),
    ]);
    candidates.into_iter().find(|path| path.is_file())
}

#[tauri::command]
pub fn cass_status() -> CassStatus {
    let path = cass_path();
    CassStatus {
        available: path.is_some(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Read CASS's bounded, redacted swarm status snapshot for one workspace. CASS
/// owns provider discovery and redaction; Instant only transports its JSON.
#[tauri::command]
pub async fn cass_swarm_status(cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || cass_swarm_status_blocking(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn cass_swarm_status_blocking(cwd: String) -> Result<Value, String> {
    let cass = cass_path().ok_or("cass is not installed")?;
    let output = std::process::Command::new(cass)
        .args(["swarm", "status", "--robot-format", "json"])
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run cass swarm status: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("cass swarm status exited with {}", output.status)
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("cass swarm status returned invalid JSON: {error}"))
}

fn codex_session_path(session_id: &str) -> Option<PathBuf> {
    fn walk(dir: &PathBuf, id: &str) -> Option<PathBuf> {
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, id) { return Some(found); }
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(id))
            { return Some(path); }
        }
        None
    }
    walk(&home()?.join(".codex").join("sessions"), session_id)
}

fn kimi_session_path(session_id: &str) -> Option<PathBuf> {
    let root = home()?.join(".kimi-code").join("sessions");
    for workspace in fs::read_dir(root).ok()?.flatten() {
        let path = workspace.path().join(format!("session_{session_id}")).join("agents").join("main").join("wire.jsonl");
        if path.is_file() { return Some(path); }
    }
    None
}

pub(crate) fn read_codex(session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
    let Some(path) = codex_session_path(session_id) else { return Vec::new() };
    let Ok(file) = fs::File::open(&path) else { return Vec::new() };
    let mut out = Vec::new();
    let mut tool_names = HashMap::<String, String>::new();
    for (seq, line) in BufReader::new(file).lines().enumerate() {
        let seq = seq as u64;
        if after_seq.is_some_and(|n| seq <= n) { continue; }
        let Ok(v) = line.ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).ok_or(()) else { continue };
        let Some(payload) = v.get("payload") else { continue };
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let (id, role, subtype, text) = match kind {
            "message" => {
                let Some(role) = payload.get("role").and_then(Value::as_str) else { continue; };
                if role != "user" && role != "assistant" { continue; }
                let text = payload.get("content").and_then(|c| c.as_array()).map(|parts| {
                    parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
                }).unwrap_or_default();
                if text.trim().is_empty() { continue; }
                (payload.get("id").and_then(Value::as_str).unwrap_or("").to_string(), role.to_string(), None, text)
            }
            "custom_tool_call" | "function_call" => {
                let name = payload.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) { tool_names.insert(call_id.to_string(), name.clone()); }
                let key = if kind == "custom_tool_call" { "input" } else { "arguments" };
                let input = payload.get(key).map(codex_value_text).unwrap_or_default();
                (payload.get("id").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), Some(name), cap(&input, 400))
            }
            "custom_tool_call_output" | "function_call_output" => {
                let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
                let subtype = tool_names.get(call_id).map(|name| format!("{name} result")).unwrap_or_else(|| "tool result".to_string());
                let output = payload.get("output").map(codex_value_text).unwrap_or_default();
                (String::new(), "assistant".to_string(), Some(subtype), cap(&output, 400))
            }
            "reasoning" => (payload.get("id").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), Some("reasoning".to_string()), "reasoning trace".to_string()),
            _ => continue,
        };
        let id = if id.is_empty() { format!("codex-{seq}") } else { id };
        // Codex timestamps its JSONL envelope, rather than the message payload.
        // Preserve that wall-clock value so the sidebar does not fall back to
        // its sequence number (`#2897`) as a synthetic time.
        let ts = v.get("timestamp").and_then(Value::as_str).map(iso_to_ms).unwrap_or(0);
        out.push(AiMessage { editor: Editor::Codex, session_id: session_id.to_string(), id,
            seq, role, subtype, ts, preview: cap(&text, 180), text,
            locator: format!("codex:{}#L{}", path.display(), seq + 1) });
    }
    out
}

fn codex_value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().filter_map(|item| {
            item.get("text").and_then(Value::as_str).map(str::to_string)
                .or_else(|| item.as_str().map(str::to_string))
        }).collect::<Vec<_>>().join("\n"),
        _ => value.to_string(),
    }
}

pub(crate) fn read_kimi(session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
    let Some(path) = kimi_session_path(session_id) else { return Vec::new() };
    let Ok(file) = fs::File::open(&path) else { return Vec::new() };
    let mut out = Vec::new();
    let mut tool_names = HashMap::<String, String>::new();
    for (seq, line) in BufReader::new(file).lines().enumerate() {
        let seq = seq as u64;
        if after_seq.is_some_and(|n| seq <= n) { continue; }
        let Ok(v) = line.ok().and_then(|line| serde_json::from_str::<Value>(&line).ok()).ok_or(()) else { continue };
        let ts = v.get("time").and_then(Value::as_u64).unwrap_or(0);
        let (id, role, subtype, text) = match v.get("type").and_then(Value::as_str) {
            Some("turn.prompt") => {
                let text = v.get("input").and_then(Value::as_array).map(|items| items.iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                if text.is_empty() { continue; }
                (String::new(), "user".to_string(), None, text)
            }
            Some("context.append_loop_event") => {
                let Some(event) = v.get("event") else { continue };
                match event.get("type").and_then(Value::as_str) {
                    Some("content.part") => {
                        let Some(part) = event.get("part") else { continue };
                        match part.get("type").and_then(Value::as_str) {
                            Some("text") => (part.get("uuid").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), None, part.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                            Some("think") => (part.get("uuid").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), Some("thinking".to_string()), cap(part.get("think").and_then(Value::as_str).unwrap_or("thinking trace"), 600)),
                            _ => continue,
                        }
                    }
                    Some("tool.call") => {
                        let name = event.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                        if let Some(call_id) = event.get("toolCallId").and_then(Value::as_str) { tool_names.insert(call_id.to_string(), name.clone()); }
                        (event.get("uuid").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), Some(name), cap(&event.get("args").map(codex_value_text).unwrap_or_default(), 400))
                    }
                    Some("tool.result") => {
                        let call_id = event.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                        let subtype = tool_names.get(call_id).map(|name| format!("{name} result")).unwrap_or_else(|| "tool result".to_string());
                        let text = event.get("result").map(codex_value_text).unwrap_or_default();
                        (event.get("uuid").and_then(Value::as_str).unwrap_or("").to_string(), "assistant".to_string(), Some(subtype), cap(&text, 400))
                    }
                    _ => continue,
                }
            }
            _ => continue,
        };
        if text.trim().is_empty() { continue; }
        let id = if id.is_empty() { format!("kimi-{seq}") } else { id };
        out.push(AiMessage { editor: Editor::Kimi, session_id: session_id.to_string(), id, seq, role, subtype, ts, preview: cap(&text, 180), text, locator: format!("kimi:{}#L{}", path.display(), seq + 1) });
    }
    out
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

pub(crate) fn iso_to_ms(s: &str) -> u64 {
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

// A claude `type:"user"` line covers three different things on the wire: a
// real typed message, a tool result routed back through the user role (it
// carries a sibling `toolUseResult` field and a `tool_result` content block),
// and injected content such as skill/slash-command bodies (`isMeta: true`).
// Classify on content block types and the isMeta flag, never on "string vs
// array": a real message can still be an array of blocks (image + text).
fn content_has_tool_result(content: &Value) -> bool {
    content.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
    })
}

// Sessions written before `promptSource` existed leave only the tag the CLI
// wraps injected content in. Each of these is a whole message on its own, never
// a prefix on something the user typed.
const INJECTED_TAGS: [&str; 9] = [
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
    "system-reminder",
];

fn first_text(content: &Value) -> Option<&str> {
    if let Some(s) = content.as_str() {
        return Some(s);
    }
    content.as_array()?.iter().find_map(|b| {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            b.get("text").and_then(|t| t.as_str())
        } else {
            None
        }
    })
}

fn injected_tag(content: &Value) -> Option<String> {
    let (tag, _) = first_text(content)?.trim_start().strip_prefix('<')?.split_once('>')?;
    INJECTED_TAGS
        .contains(&tag)
        .then(|| tag.to_string())
}

fn classify_user_line(v: &Value, content: &Value) -> (String, Option<String>) {
    if content_has_tool_result(content) {
        return ("tool".to_string(), Some("tool_result".to_string()));
    }
    let flag = |key: &str| v.get(key).and_then(|b| b.as_bool()).unwrap_or(false);
    let origin = v
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str());
    // The CLI stamps everything it writes on the user's behalf: task
    // notifications, compaction summaries, slash-command bodies, hook output.
    // None of it was typed, so none of it is a user row. `promptSource` is
    // "typed" or "queued" for real input and "system" for injections.
    if v.get("promptSource").and_then(|p| p.as_str()) == Some("system") {
        return ("meta".to_string(), Some(origin.unwrap_or("system").to_string()));
    }
    if flag("isCompactSummary") {
        return ("meta".to_string(), Some("compact-summary".to_string()));
    }
    if flag("isMeta") {
        // Subtype stays None when nothing names the injection: the sidebar
        // label is `role · subtype`, which would otherwise read "meta · meta".
        return (
            "meta".to_string(),
            origin.map(str::to_string).or_else(|| injected_tag(content)),
        );
    }
    if let Some(tag) = injected_tag(content) {
        return ("meta".to_string(), Some(tag));
    }
    // Includes "[Request interrupted by user]": that's something the user
    // actually did, so it stays a user row on purpose.
    ("user".to_string(), None)
}

// Read every turn from one claude jsonl. `after_seq` skips lines already seen
// (the watcher passes the last line index). Only user/assistant rows become
// messages; system/mode/snapshot lines are skipped but still advance `seq` so
// the line index stays an exact file offset.
pub(crate) fn read_claude(path: &PathBuf, session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
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
        let msg_type = match v.get("type").and_then(|t| t.as_str()) {
            Some(t @ ("user" | "assistant")) => t,
            _ => continue,
        };
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .cloned()
            .unwrap_or(Value::Null);
        let (role, subtype) = if msg_type == "assistant" {
            ("assistant".to_string(), None)
        } else {
            classify_user_line(&v, &content)
        };
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
            role,
            subtype,
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

pub(crate) fn read_opencode(session_id: &str, after_seq: Option<u64>) -> Vec<AiMessage> {
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
            subtype: None,
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
pub async fn read_ai_messages(
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
) -> Result<Vec<AiMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_ai_messages_blocking(editor, session_id, cwd, after_seq)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_ai_messages_blocking(
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
) -> Result<Vec<AiMessage>, String> {
    let id = crate::harness_store::HarnessId::parse(&editor).ok_or("unknown editor")?;
    Ok(crate::harness_store::messages(id, &session_id, &cwd, after_seq))
}

/// The newest turn in a session (drives "favorite current turn" + the watcher).
#[tauri::command]
pub async fn latest_ai_message(
    editor: String,
    session_id: String,
    cwd: String,
) -> Result<Option<AiMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut msgs = read_ai_messages_blocking(editor, session_id, cwd, None)?;
        Ok(msgs.pop())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sessions for a cwd (or all, when cwd is None), newest first. Lightweight
/// browse list; reading the turns is a separate call.
#[tauri::command]
pub async fn list_ai_sessions(editor: String, cwd: Option<String>) -> Result<Vec<AiSession>, String> {
    tauri::async_runtime::spawn_blocking(move || list_ai_sessions_blocking(editor, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn list_ai_sessions_blocking(editor: String, cwd: Option<String>) -> Result<Vec<AiSession>, String> {
    let editor = Editor::parse(&editor).ok_or("unknown editor")?;
    let harness = crate::harness_store::HarnessId::parse(editor.tag()).ok_or("unknown editor")?;
    let Some(home) = home() else { return Ok(Vec::new()) };
    Ok(crate::harness_store::sessions(&home, harness, cwd.as_deref())
        .into_iter()
        .map(|session| {
            let title = session.title.clone().unwrap_or_else(|| {
                crate::harness_store::messages(harness, &session.id, &session.cwd, None)
                    .into_iter()
                    .find(|message| message.role == "user")
                    .map(|message| message.preview)
                    .unwrap_or_default()
            });
            AiSession {
                editor,
                id: session.id,
                cwd: session.cwd,
                title,
                updated: session.last_activity_ms,
                path: session.source_path,
            }
        })
        .collect())
}

// Re-export the editor tag for the favorites module's identity strings.
pub fn editor_tag(editor: &Editor) -> &'static str {
    editor.tag()
}
// todo(split): separate Claude and OpenCode parsing from ledger query orchestration
// todo(test): add fixture coverage for malformed and partially-written session logs

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    // One temp file per test, keyed by pid + a counter, so parallel `cargo
    // test` runs never collide on the same path.
    fn write_temp(lines: &[&str]) -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("ledger_test_{}_{n}.jsonl", std::process::id()));
        let mut file = fs::File::create(&path).expect("write temp fixture");
        for line in lines {
            writeln!(file, "{line}").expect("write temp fixture line");
        }
        path
    }

    #[test]
    fn title_lookup_skips_leading_tool_and_meta_rows() {
        // Mirrors list_ai_sessions' `.find(|m| m.role == "user")`: a
        // session whose first lines are tool output / injected content must
        // still resolve its title to the first real typed message.
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isMeta":false,"toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-07-20T10:00:01.000Z","isMeta":true,"message":{"role":"user","content":"injected skill body"}}"#,
            r#"{"type":"user","uuid":"u3","timestamp":"2026-07-20T10:00:02.000Z","isMeta":false,"message":{"role":"user","content":"fix the off-by-one bug"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        let title = out.into_iter().find(|m| m.role == "user").map(|m| m.preview);
        assert_eq!(title.as_deref(), Some("fix the off-by-one bug"));
    }

    #[test]
    fn string_content_is_a_user_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isMeta":false,"message":{"role":"user","content":"hello there"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[0].subtype, None);
    }

    #[test]
    fn tool_result_block_is_a_tool_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u2","timestamp":"2026-07-20T10:00:01.000Z","isMeta":false,"toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "tool");
        assert_eq!(out[0].subtype.as_deref(), Some("tool_result"));
    }

    #[test]
    fn meta_string_content_is_a_meta_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u3","timestamp":"2026-07-20T10:00:02.000Z","isMeta":true,"message":{"role":"user","content":"<command-name>/compact</command-name> body"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "meta");
        assert_eq!(out[0].subtype.as_deref(), Some("command-name"));
    }

    #[test]
    fn task_notification_is_a_meta_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u6","timestamp":"2026-07-20T10:00:06.000Z","promptSource":"system","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>a06c1e6</task-id>\n<status>completed</status>\n</task-notification>"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "meta");
        assert_eq!(out[0].subtype.as_deref(), Some("task-notification"));
    }

    #[test]
    fn compact_summary_is_a_meta_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u7","timestamp":"2026-07-20T10:00:07.000Z","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation…"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "meta");
        assert_eq!(out[0].subtype.as_deref(), Some("compact-summary"));
    }

    // Sessions written before `promptSource` existed carry no flag at all, so
    // the wrapper tag is the only marker left.
    #[test]
    fn legacy_command_body_is_a_meta_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u8","timestamp":"2026-07-20T10:00:08.000Z","message":{"role":"user","content":[{"type":"text","text":"<command-name>/compact</command-name>\n<command-message>compact</command-message>"}]}}"#,
            r#"{"type":"user","uuid":"u9","timestamp":"2026-07-20T10:00:09.000Z","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Compacted</local-command-stdout>"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, "meta");
        assert_eq!(out[0].subtype.as_deref(), Some("command-name"));
        assert_eq!(out[1].role, "meta");
        assert_eq!(out[1].subtype.as_deref(), Some("local-command-stdout"));
    }

    #[test]
    fn typed_and_queued_input_stay_user_rows() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"ua","timestamp":"2026-07-20T10:00:10.000Z","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"ship it"}}"#,
            r#"{"type":"user","uuid":"ub","timestamp":"2026-07-20T10:00:11.000Z","promptSource":"queued","origin":{"kind":"human"},"message":{"role":"user","content":"and then this"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 2);
        let roles: Vec<&str> = out.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "user"]);
    }

    // A message that merely mentions a tag is not an injection: the wrapper has
    // to open the message.
    #[test]
    fn prose_about_a_tag_stays_a_user_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"uc","timestamp":"2026-07-20T10:00:12.000Z","message":{"role":"user","content":"why does <command-name> show up in the sidebar"}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "user");
    }

    #[test]
    fn meta_text_block_is_a_meta_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u4","timestamp":"2026-07-20T10:00:03.000Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"injected content"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "meta");
        assert_eq!(out[0].subtype, None);
    }

    // Recorded on purpose as a user row: it's something the user actually did.
    #[test]
    fn interrupted_message_stays_a_user_row() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u5","timestamp":"2026-07-20T10:00:04.000Z","isMeta":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[0].subtype, None);
    }

    #[test]
    fn assistant_line_is_unaffected() {
        let path = write_temp(&[
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"here is my answer"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "assistant");
        assert_eq!(out[0].subtype, None);
    }

    #[test]
    fn seq_is_the_line_index_across_skipped_lines() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isMeta":false,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"system","content":"mode change"}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-07-20T10:00:01.000Z","isMeta":false,"toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
        ]);
        let out = read_claude(&path, "s", None);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].seq, 0);
        assert_eq!(out[1].seq, 2);
        assert_eq!(out[2].seq, 3);
    }

    #[test]
    fn after_seq_skips_up_to_and_including_that_index() {
        let path = write_temp(&[
            r#"{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isMeta":false,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"system","content":"mode change"}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-07-20T10:00:01.000Z","isMeta":false,"toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
        ]);
        let out = read_claude(&path, "s", Some(0));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].seq, 2);
        assert_eq!(out[1].seq, 3);
    }

    // Captured from a real session by `node scripts/capture-transcripts.mjs`,
    // trimmed and de-identified. Regenerate with that script when the harness
    // wire format changes.
    fn fixture(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("transcripts")
            .join(rel)
    }

    #[test]
    fn captured_claude_session_labels_every_row_by_its_wire_shape() {
        let path = fixture("claude/session.jsonl");
        let raw = fs::read_to_string(&path).expect("captured fixture missing");
        let out = read_claude(&path, "s", None);
        let (mut tool, mut user, mut meta) = (0, 0, 0);
        for (i, line) in raw.lines().enumerate() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("user") {
                continue;
            }
            let Some(row) = out.iter().find(|m| m.seq == i as u64) else {
                continue;
            };
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .cloned()
                .unwrap_or(Value::Null);
            let tagged = first_text(&content).is_some_and(|t| {
                let t = t.trim_start();
                INJECTED_TAGS.iter().any(|tag| t.starts_with(&format!("<{tag}>")))
            });
            let injected = tagged
                || v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false)
                || v.get("isCompactSummary").and_then(|m| m.as_bool()).unwrap_or(false)
                || v.get("promptSource").and_then(|p| p.as_str()) == Some("system");
            if content_has_tool_result(&content) {
                assert_eq!(row.role, "tool", "line {} carries tool output", i + 1);
                tool += 1;
            } else if injected {
                assert_eq!(row.role, "meta", "line {} is injected", i + 1);
                meta += 1;
            } else {
                assert_eq!(row.role, "user", "line {} was typed by the user", i + 1);
                user += 1;
            }
        }
        assert!(tool > 0, "fixture lost its tool rows");
        assert!(user > 0, "fixture lost its user rows");
        assert!(meta > 0, "fixture lost its meta rows");
    }

    #[test]
    fn captured_claude_subagent_session_parses() {
        let path = fixture("claude/subagent.jsonl");
        let out = read_claude(&path, "s", None);
        assert!(!out.is_empty(), "subagent fixture produced no rows");
        assert!(
            out.iter().any(|m| m.role == "assistant"),
            "subagent fixture has no assistant rows"
        );
        let raw = fs::read_to_string(&path).expect("captured fixture missing");
        assert!(
            raw.lines().any(|l| l.contains(r#""isSidechain":true"#)),
            "subagent fixture must keep its sidechain marker"
        );
    }
}
