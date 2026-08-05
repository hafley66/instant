use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HarnessId {
    Claude,
    Opencode,
    Codex,
    Kimi,
}

impl HarnessId {
    pub fn parse(value: &str) -> Option<Self> {
        match value.rsplit('/').next().unwrap_or(value) {
            "claude" => Some(Self::Claude),
            "opencode" => Some(Self::Opencode),
            "codex" => Some(Self::Codex),
            "kimi" => Some(Self::Kimi),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Opencode => "opencode",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSession {
    pub id: String,
    pub harness: &'static str,
    pub cwd: String,
    pub source_path: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub parent_id: Option<String>,
    pub parent_kind: Option<&'static str>,
    pub created_at_ms: u64,
    pub last_activity_ms: u64,
}

pub trait HarnessStore: Sync {
    fn id(&self) -> HarnessId;
    fn sessions(&self, home: &Path, cwd: Option<&str>) -> Vec<HarnessSession>;
    fn messages(
        &self,
        session_id: &str,
        cwd: &str,
        after_seq: Option<u64>,
    ) -> Vec<crate::AiMessage>;
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

// Session discovery is called when the harness strip mounts. Rollout files can
// be hundreds of megabytes, while their identity lives at the head and their
// latest usage lives at the tail. Keep discovery bounded instead of reading
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

pub struct ClaudeStore;
fn claude_session(path: &Path, parent_id: Option<String>) -> Option<HarnessSession> {
    let id = path.file_stem()?.to_str()?.to_string();
    let mut cwd = String::new();
    let mut created_at_ms = 0;
    let mut input_tokens = None;
    let mut sidechain = false;
    let head = head_values(path);
    for value in &head {
        sidechain |= value.get("isSidechain").and_then(Value::as_bool) == Some(true);
        if cwd.is_empty() {
            cwd = value
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        if created_at_ms == 0 {
            created_at_ms = value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(crate::ledger::iso_to_ms)
                .unwrap_or(0);
        }
    }
    for value in tail_values(path).iter().rev().chain(head.iter().rev()) {
        let Some(u) = usage(value, 0) else { continue };
        input_tokens = Some(
            u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0)
                + u.get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                + u.get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
        );
        break;
    }
    if sidechain && parent_id.is_none() {
        return None;
    }
    Some(HarnessSession {
        id,
        harness: "claude",
        cwd,
        source_path: Some(path.to_string_lossy().into_owned()),
        title: None,
        model: None,
        input_tokens,
        parent_kind: parent_id.as_ref().map(|_| "subagent"),
        parent_id,
        created_at_ms,
        last_activity_ms: mtime(path),
    })
}

impl HarnessStore for ClaudeStore {
    fn id(&self) -> HarnessId {
        HarnessId::Claude
    }
    fn sessions(&self, home: &Path, cwd: Option<&str>) -> Vec<HarnessSession> {
        let projects = home.join(".claude/projects");
        let dirs: Vec<PathBuf> = match cwd {
            Some(cwd) => vec![projects.join(
                cwd.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect::<String>(),
            )],
            None => fs::read_dir(projects)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .collect(),
        };
        let mut out = Vec::new();
        for dir in dirs {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    if let Some(session) = claude_session(&path, None)
                        .filter(|session| cwd.is_none_or(|wanted| session.cwd == wanted))
                    {
                        out.push(session);
                    }
                } else if path.is_dir() {
                    let parent = entry.file_name().to_string_lossy().to_string();
                    let Ok(subagents) = fs::read_dir(path.join("subagents")) else {
                        continue;
                    };
                    for subagent in subagents.flatten() {
                        if let Some(session) =
                            claude_session(&subagent.path(), Some(parent.clone()))
                                .filter(|session| cwd.is_none_or(|wanted| session.cwd == wanted))
                        {
                            out.push(session);
                        }
                    }
                }
            }
        }
        sorted(out)
    }
    fn messages(
        &self,
        session_id: &str,
        cwd: &str,
        after_seq: Option<u64>,
    ) -> Vec<crate::ledger::AiMessage> {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return vec![];
        };
        let Some(path) = self
            .sessions(&home, Some(cwd))
            .into_iter()
            .find(|session| session.id == session_id)
            .and_then(|session| session.source_path)
        else {
            return vec![];
        };
        crate::ledger::read_claude(&PathBuf::from(path), session_id, after_seq)
    }
}

pub struct OpencodeStore;
impl HarnessStore for OpencodeStore {
    fn id(&self) -> HarnessId {
        HarnessId::Opencode
    }
    fn sessions(&self, home: &Path, cwd: Option<&str>) -> Vec<HarnessSession> {
        let db = home.join(".local/share/opencode/opencode.db");
        let Ok(conn) = Connection::open_with_flags(
            db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            return vec![];
        };
        let sql = "SELECT s.id,s.directory,s.title,s.time_created,s.time_updated,(SELECT json_extract(m.data,'$.tokens.input') FROM message m WHERE m.session_id=s.id ORDER BY m.time_created DESC LIMIT 1) FROM session s WHERE s.time_archived IS NULL AND (?1 IS NULL OR s.directory=?1) ORDER BY s.time_updated DESC";
        let Ok(mut stmt) = conn.prepare(sql) else {
            return vec![];
        };
        let Ok(rows) = stmt.query_map([cwd], |row| {
            Ok(HarnessSession {
                id: row.get(0)?,
                harness: self.id().as_str(),
                cwd: row.get(1)?,
                source_path: None,
                title: row.get(2)?,
                model: None,
                input_tokens: row.get::<_, Option<i64>>(5)?.map(|n| n as u64),
                parent_id: None,
                parent_kind: None,
                created_at_ms: row.get::<_, i64>(3)? as u64,
                last_activity_ms: row.get::<_, i64>(4)? as u64,
            })
        }) else {
            return vec![];
        };
        rows.flatten().collect()
    }
    fn messages(
        &self,
        session_id: &str,
        _cwd: &str,
        after_seq: Option<u64>,
    ) -> Vec<crate::ledger::AiMessage> {
        crate::ledger::read_opencode(session_id, after_seq)
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

pub struct CodexStore;
impl HarnessStore for CodexStore {
    fn id(&self) -> HarnessId {
        HarnessId::Codex
    }
    fn sessions(&self, home: &Path, cwd: Option<&str>) -> Vec<HarnessSession> {
        let mut files = Vec::new();
        collect_jsonl(&home.join(".codex/sessions"), &mut files);
        let mut out = Vec::new();
        for path in files {
            let head = head_values(&path);
            let Some(first) = head.first() else {
                continue;
            };
            if first.get("type").and_then(Value::as_str) != Some("session_meta") {
                continue;
            }
            let meta = first.get("payload").unwrap_or(&first);
            let found_cwd = meta.get("cwd").and_then(Value::as_str).unwrap_or("");
            if cwd.is_some_and(|wanted| found_cwd != wanted) {
                continue;
            }
            let Some(id) = meta.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut model = None;
            let mut input_tokens = None;
            for value in head.iter().chain(tail_values(&path).iter()) {
                if value.get("type").and_then(Value::as_str) == Some("turn_context") {
                    model = value
                        .pointer("/payload/model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count") {
                    input_tokens = value
                        .pointer("/payload/info/total_token_usage/input_tokens")
                        .and_then(Value::as_u64);
                }
            }
            let parent_id = meta
                .get("parent_thread_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let parent_kind = (parent_id.is_some()
                || meta.get("thread_source").and_then(Value::as_str) == Some("subagent"))
            .then_some("subagent");
            out.push(HarnessSession {
                id: id.to_string(),
                harness: self.id().as_str(),
                cwd: found_cwd.to_string(),
                source_path: Some(path.to_string_lossy().into_owned()),
                title: None,
                model,
                input_tokens,
                parent_id,
                parent_kind,
                created_at_ms: first
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(crate::ledger::iso_to_ms)
                    .unwrap_or(0),
                last_activity_ms: mtime(&path),
            });
        }
        sorted(out)
    }
    fn messages(
        &self,
        session_id: &str,
        _cwd: &str,
        after_seq: Option<u64>,
    ) -> Vec<crate::ledger::AiMessage> {
        crate::ledger::read_codex(session_id, after_seq)
    }
}

pub struct KimiStore;
impl HarnessStore for KimiStore {
    fn id(&self) -> HarnessId {
        HarnessId::Kimi
    }
    fn sessions(&self, home: &Path, cwd: Option<&str>) -> Vec<HarnessSession> {
        let Ok(workspaces) = fs::read_dir(home.join(".kimi-code/sessions")) else {
            return vec![];
        };
        let mut out = Vec::new();
        for workspace in workspaces.flatten() {
            let Ok(sessions) = fs::read_dir(workspace.path()) else {
                continue;
            };
            for session in sessions.flatten() {
                let path = session.path();
                let state = path.join("state.json");
                let Ok(meta) = fs::read_to_string(&state)
                    .ok()
                    .and_then(|x| json(&x))
                    .ok_or(())
                else {
                    continue;
                };
                let found_cwd = meta.get("workDir").and_then(Value::as_str).unwrap_or("");
                if cwd.is_some_and(|wanted| found_cwd != wanted) {
                    continue;
                }
                let Some(id) = session
                    .file_name()
                    .to_string_lossy()
                    .strip_prefix("session_")
                    .map(str::to_string)
                else {
                    continue;
                };
                let wire = path.join("agents/main/wire.jsonl");
                out.push(HarnessSession {
                    id,
                    harness: self.id().as_str(),
                    cwd: found_cwd.to_string(),
                    source_path: Some(wire.to_string_lossy().into_owned()),
                    title: None,
                    model: None,
                    input_tokens: None,
                    parent_id: None,
                    parent_kind: None,
                    created_at_ms: created(&state),
                    last_activity_ms: mtime(&state),
                });
            }
        }
        sorted(out)
    }
    fn messages(
        &self,
        session_id: &str,
        _cwd: &str,
        after_seq: Option<u64>,
    ) -> Vec<crate::ledger::AiMessage> {
        crate::ledger::read_kimi(session_id, after_seq)
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

static CLAUDE: ClaudeStore = ClaudeStore;
static OPENCODE: OpencodeStore = OpencodeStore;
static CODEX: CodexStore = CodexStore;
static KIMI: KimiStore = KimiStore;
pub fn store(id: HarnessId) -> &'static dyn HarnessStore {
    match id {
        HarnessId::Claude => &CLAUDE,
        HarnessId::Opencode => &OPENCODE,
        HarnessId::Codex => &CODEX,
        HarnessId::Kimi => &KIMI,
    }
}
pub fn sessions(home: &Path, id: HarnessId, cwd: Option<&str>) -> Vec<HarnessSession> {
    store(id).sessions(home, cwd)
}
pub fn resolve(home: &Path, id: HarnessId, cwd: &str) -> Option<HarnessSession> {
    sessions(home, id, Some(cwd)).into_iter().next()
}
pub fn messages(
    id: HarnessId,
    session_id: &str,
    cwd: &str,
    after_seq: Option<u64>,
) -> Vec<crate::AiMessage> {
    store(id).messages(session_id, cwd, after_seq)
}

#[cfg(test)]
#[path = "0_harness_store_tests.rs"]
mod tests;
