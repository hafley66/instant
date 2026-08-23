use boop_harness::{HarnessId, Registry, SessionRef};
use boop_mux::{Multiplexer, Tmux};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The one row the harness strip renders. Discovery is boop-harness's
/// `SessionRef`; every field here is instant's own shaping of it for the UI.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSession {
    pub id: String,
    pub harness: HarnessId,
    pub cwd: String,
    pub source_path: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub input_tokens: Option<u64>,
    pub parent_id: Option<String>,
    pub parent_kind: Option<&'static str>,
    pub created_at_ms: u64,
    pub last_activity_ms: u64,
}

fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn created(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn json(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

// Session shaping is called when the harness strip mounts. Rollout files can
// be hundreds of megabytes, while their identity lives at the head and their
// latest usage lives at the tail. Keep the read bounded instead of pulling
// every transcript into memory before the first frame can finish booting.
const SESSION_HEAD_LINES: usize = 128;
const SESSION_TAIL_BYTES: u64 = 256 * 1024;

fn head_values(path: &Path) -> Vec<Value> {
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    BufReader::new(file)
        .lines()
        .take(SESSION_HEAD_LINES)
        .map_while(Result::ok)
        .filter_map(|line| json(&line))
        .collect()
}

fn tail_values(path: &Path) -> Vec<Value> {
    let Ok(mut file) = fs::File::open(path) else {
        return vec![];
    };
    let Ok(len) = file.seek(SeekFrom::End(0)) else {
        return vec![];
    };
    let start = len.saturating_sub(SESSION_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return vec![];
    }
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // the bounded read may begin in the middle of a JSON line
    }
    lines.filter_map(json).collect()
}

fn usage(value: &Value, depth: usize) -> Option<&Value> {
    if depth > 6 {
        return None;
    }
    let object = value.as_object()?;
    if object.get("input_tokens").and_then(Value::as_u64).is_some() {
        return Some(value);
    }
    object.values().find_map(|child| usage(child, depth + 1))
}

/// The id the harness resumes on. claude names a subagent transcript
/// `<parent>/<stem>` while `claude --resume` takes the stem alone.
fn resume_id(session: &SessionRef) -> &str {
    match session.harness {
        HarnessId::Claude => &session.nickname,
        _ => &session.session_id,
    }
}

/// Every session boop-harness can see for one harness, filtered to `cwd` when
/// one is given. Nothing here parses a transcript.
fn refs(id: HarnessId, cwd: Option<&str>) -> Vec<SessionRef> {
    Registry::discover()
        .get(id)
        .sessions()
        .unwrap_or_default()
        .into_iter()
        .filter(|session| cwd.is_none_or(|wanted| session.cwd.as_deref() == Some(wanted)))
        // kimi writes one wire.jsonl per agent under a session; the strip lists
        // the session, so only its main agent is a row.
        .filter(|session| session.harness != HarnessId::Kimi || session.parent.is_none())
        .collect()
}

fn claude_shape(session: &SessionRef) -> Option<HarnessSession> {
    let head = head_values(&session.path);
    let sidechain = head
        .iter()
        .any(|value| value.get("isSidechain").and_then(Value::as_bool) == Some(true));
    if sidechain && session.parent.is_none() {
        return None;
    }
    let created_at_ms = head
        .iter()
        .find_map(|value| value.get("timestamp").and_then(Value::as_str))
        .map(crate::ledger::iso_to_ms)
        .unwrap_or(0);
    let input_tokens = tail_values(&session.path)
        .iter()
        .rev()
        .chain(head.iter().rev())
        .find_map(|value| usage(value, 0))
        .map(|u| {
            u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0)
                + u.get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                + u.get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
        });
    Some(HarnessSession {
        id: session.nickname.clone(),
        harness: HarnessId::Claude,
        cwd: session.cwd.clone().unwrap_or_default(),
        source_path: Some(session.path.to_string_lossy().into_owned()),
        title: None,
        model: None,
        provider: Some("anthropic".to_string()),
        input_tokens,
        parent_kind: session.parent.as_ref().map(|_| "subagent"),
        parent_id: session.parent.clone(),
        created_at_ms,
        last_activity_ms: session.modified_ms,
    })
}

fn codex_shape(session: &SessionRef) -> Option<HarnessSession> {
    let head = head_values(&session.path);
    let first = head.first()?;
    let meta = first.get("payload").unwrap_or(first);
    let mut model = None;
    let mut provider = None;
    let mut input_tokens = None;
    for value in head.iter().chain(tail_values(&session.path).iter()) {
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            model = value
                .pointer("/payload/model")
                .and_then(Value::as_str)
                .map(str::to_string);
            provider = value
                .pointer("/payload/model_provider")
                .or_else(|| value.pointer("/payload/modelProvider"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count") {
            input_tokens = value
                .pointer("/payload/info/total_token_usage/input_tokens")
                .and_then(Value::as_u64);
        }
    }
    let parent_kind = (session.parent.is_some()
        || meta.get("thread_source").and_then(Value::as_str) == Some("subagent"))
    .then_some("subagent");
    Some(HarnessSession {
        id: session.session_id.clone(),
        harness: HarnessId::Codex,
        cwd: session.cwd.clone().unwrap_or_default(),
        source_path: Some(session.path.to_string_lossy().into_owned()),
        title: None,
        model,
        provider,
        input_tokens,
        parent_id: session.parent.clone(),
        parent_kind,
        created_at_ms: first
            .get("timestamp")
            .and_then(Value::as_str)
            .map(crate::ledger::iso_to_ms)
            .unwrap_or(0),
        last_activity_ms: session.modified_ms,
    })
}

// Sum the input-side usage from the last kimi wire.jsonl line that carries one,
// plus the model on that line; output tokens are not the context reading.
fn kimi_wire_meta(wire: &Path) -> (Option<u64>, Option<String>, Option<String>) {
    let mut tokens = None;
    let mut model = None;
    let mut provider = None;
    let Ok(file) = fs::File::open(wire) else {
        return (tokens, model, provider);
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Some(value) = json(&line) else {
            continue;
        };
        if let Some(usage) = value.get("usage") {
            tokens = Some(
                wire_num(usage, "inputOther")
                    + wire_num(usage, "inputCacheRead")
                    + wire_num(usage, "inputCacheCreation"),
            );
        }
        if let Some(name) = value.get("model").and_then(Value::as_str) {
            model = Some(name.to_string());
        }
        if let Some(name) = value.get("provider").and_then(Value::as_str) {
            provider = Some(name.to_string());
        }
    }
    (tokens, model, provider)
}

fn wire_num(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// `<session dir>/agents/<agent>/wire.jsonl` -> `<session dir>/state.json`.
fn kimi_state_path(wire: &Path) -> PathBuf {
    wire.ancestors()
        .nth(3)
        .unwrap_or(wire)
        .join("state.json")
}

fn kimi_shape(session: &SessionRef) -> Option<HarnessSession> {
    let state = kimi_state_path(&session.path);
    let (input_tokens, model, provider) = kimi_wire_meta(&session.path);
    Some(HarnessSession {
        id: session.session_id.clone(),
        harness: HarnessId::Kimi,
        cwd: session.cwd.clone().unwrap_or_default(),
        source_path: Some(session.path.to_string_lossy().into_owned()),
        title: None,
        model,
        provider,
        input_tokens,
        parent_id: None,
        parent_kind: None,
        created_at_ms: created(&state),
        last_activity_ms: session.modified_ms.max(mtime(&state)),
    })
}

fn opencode_shape(session: &SessionRef) -> Option<HarnessSession> {
    let connection = Connection::open_with_flags(
        &session.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // tokens.total is OpenCode's complete context reading; tokens.input
    // excludes cache reads. An archived row is not a resumable session.
    let sql = "SELECT s.title,s.time_created,(SELECT MAX(COALESCE(json_extract(m.data,'$.tokens.total'),json_extract(m.data,'$.tokens.input'))) FROM message m WHERE m.session_id=s.id),(SELECT json_extract(m.data,'$.modelID') FROM message m WHERE m.session_id=s.id AND json_extract(m.data,'$.modelID') IS NOT NULL ORDER BY m.time_created DESC LIMIT 1),(SELECT json_extract(m.data,'$.providerID') FROM message m WHERE m.session_id=s.id AND json_extract(m.data,'$.providerID') IS NOT NULL ORDER BY m.time_created DESC LIMIT 1) FROM session s WHERE s.id=?1 AND s.time_archived IS NULL";
    let mut statement = connection.prepare(sql).ok()?;
    let row = statement
        .query_row([&session.session_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .ok()?;
    let (title, created_at_ms, input_tokens, model, provider) = row;
    Some(HarnessSession {
        id: session.session_id.clone(),
        harness: HarnessId::Opencode,
        cwd: session.cwd.clone().unwrap_or_default(),
        source_path: None,
        title,
        model,
        provider,
        input_tokens: input_tokens.map(|n| n as u64),
        parent_id: session.parent.clone(),
        parent_kind: session.parent.as_ref().map(|_| "subagent"),
        created_at_ms: created_at_ms as u64,
        last_activity_ms: session.modified_ms,
    })
}

fn shape(session: &SessionRef) -> Option<HarnessSession> {
    match session.harness {
        HarnessId::Claude => claude_shape(session),
        HarnessId::Codex => codex_shape(session),
        HarnessId::Kimi => kimi_shape(session),
        HarnessId::Opencode => opencode_shape(session),
    }
}

fn sorted(mut sessions: Vec<HarnessSession>) -> Vec<HarnessSession> {
    sessions.sort_by(|a, b| {
        b.last_activity_ms
            .cmp(&a.last_activity_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    sessions
}

pub fn sessions(id: HarnessId, cwd: Option<&str>) -> Vec<HarnessSession> {
    sorted(refs(id, cwd).iter().filter_map(shape).collect())
}

/// Newest-first resumable ids for a cwd. No transcript is parsed: the order is
/// the mtime boop-harness already stated for each session.
pub fn session_ids(id: HarnessId, cwd: &str) -> Vec<String> {
    let mut found: Vec<(u64, String)> = refs(id, Some(cwd))
        .iter()
        .map(|session| (session.modified_ms, resume_id(session).to_string()))
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.into_iter().map(|(_, id)| id).collect()
}

pub fn resolve(id: HarnessId, cwd: &str) -> Option<HarnessSession> {
    sessions(id, Some(cwd)).into_iter().next()
}

// boop-harness gap: session_by_id. `sessions()` walks every transcript under
// the root; the watcher reads one session's turns on every incremental pass.
fn claude_project_dir(home: &Path, cwd: &str) -> PathBuf {
    home.join(".claude/projects").join(
        cwd.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>(),
    )
}

// boop-harness gap: session_by_id.
fn claude_session_path(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let project = claude_project_dir(home, cwd);
    let direct = project.join(format!("{session_id}.jsonl"));
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(project).ok()?.flatten().find_map(|entry| {
        let path = entry
            .path()
            .join("subagents")
            .join(format!("{session_id}.jsonl"));
        path.is_file().then_some(path)
    })
}

pub fn messages(
    id: HarnessId,
    session_id: &str,
    cwd: &str,
    after_seq: Option<u64>,
) -> Vec<crate::AiMessage> {
    match id {
        HarnessId::Claude => {
            let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
                return vec![];
            };
            let Some(path) = claude_session_path(&home, cwd, session_id) else {
                return vec![];
            };
            crate::ledger::read_claude(&path, session_id, after_seq)
        }
        HarnessId::Codex => crate::ledger::read_codex(session_id, after_seq),
        HarnessId::Kimi => crate::ledger::read_kimi(session_id, after_seq),
        HarnessId::Opencode => crate::ledger::read_opencode(session_id, after_seq),
    }
}

/// The harness session standing in a tmux pane, answered by each harness's own
/// live registry rather than by a transcript mtime or a tmux scrape.
#[tauri::command]
pub async fn boop_mux_session(
    target: String,
    socket: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| {
            std::env::var("INSTANT_TMUX_SOCKET")
                .ok()
                .filter(|value| !value.is_empty())
        });
        let Some(pane) = boop_harness::live::pane_of_target(&target)
            .or_else(|| Tmux.pane_id(socket.as_deref(), &target))
        else {
            return Ok(None);
        };
        let registry = Registry::discover();
        for harness in registry.all() {
            if let Ok(Some(live)) = harness.live().live_session_in_pane(&pane) {
                return Ok(Some(live.session_id));
            }
        }
        route_session_in_pane(&pane)
    })
    .await
    .map_err(|error| error.to_string())?
}

// boop-harness gap: live_pane_for_every_harness. Only claude fills
// `LiveSession.tmux_pane`; the other three fall back to the boop route registry.
fn route_session_in_pane(pane: &str) -> Result<Option<String>, String> {
    let mail_dir = match std::env::var_os("BOOP_MAIL_DIR").filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => boop_store::bus::default_mail_dir().map_err(|error| error.to_string())?,
    };
    let routes = boop_store::bus::read_routes(&mail_dir).map_err(|error| error.to_string())?;
    Ok(routes.into_values().find_map(|route| {
        let held = route.tmux.as_deref()?;
        (held.trim_start_matches('%') == pane.trim_start_matches('%'))
            .then_some(route.session_id)
            .flatten()
    }))
}

#[cfg(test)]
#[path = "0_harness_store_tests.rs"]
mod tests;
