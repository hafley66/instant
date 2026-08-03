// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd, non-alnum->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use serde::Serialize;
use serde_json::Value;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// claude encodes the project dir by replacing every non-alphanumeric char with
// '-' (so '/', '.', '_', space all collapse to '-'; a '.worktrees' segment turns
// into '-worktrees'), then stores one <session-uuid>.jsonl per conversation.
// Returns every session id in the cwd, NEWEST FIRST (mtime desc) — the caller
// disambiguates when several tabs share a cwd.
fn claude_sessions(cwd: &str) -> Vec<String> {
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = match home() {
        Some(h) => h.join(".claude").join("projects").join(enc),
        None => return vec![],
    };
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut items: Vec<(SystemTime, String)> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mtime = match entry.metadata().ok().and_then(|m| m.modified().ok()) {
            Some(t) => t,
            None => continue,
        };
        items.push((mtime, stem));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    items.into_iter().map(|(_, id)| id).collect()
}

// opencode stores sessions in a SQLite db; `session.directory` is the plain cwd.
// time_archived IS NULL filters out deleted/archived sessions. Newest first.
fn opencode_sessions(cwd: &str) -> Vec<String> {
    let db = match home() {
        Some(h) => h
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db"),
        None => return vec![],
    };
    let conn = match rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut stmt = match conn.prepare(
        "SELECT id FROM session \
         WHERE directory = ?1 AND time_archived IS NULL \
         ORDER BY time_updated DESC",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let ids: Vec<String> = match stmt.query_map([cwd], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => vec![],
    };
    ids
}

// Codex CLI stores rollout JSONL files under ~/.codex/sessions/<Y>/<M>/<D>.
// The first session_meta record carries the authoritative cwd and id; scan only
// metadata, keeping this probe cheap enough for tab/session discovery.
fn codex_sessions(cwd: &str) -> Vec<String> {
    let Some(root) = home().map(|h| h.join(".codex").join("sessions")) else { return vec![] };
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files);
    let mut items: Vec<(SystemTime, String)> = Vec::new();
    for path in files {
        let Ok(file) = fs::File::open(&path) else { continue };
        let Some(Ok(line)) = BufReader::new(file).lines().next() else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let meta = if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            v.get("payload").unwrap_or(&v)
        } else { continue };
        if meta.get("cwd").and_then(Value::as_str) != Some(cwd) { continue; }
        let Some(id) = meta.get("id").and_then(Value::as_str) else { continue };
        let mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
        items.push((mtime, id.to_string()));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.into_iter().map(|(_, id)| id).collect()
}

// Kimi Code stores sessions as ~/.kimi-code/sessions/<workspace>/session_<id>/.
// The state file carries the workspace and update timestamp; only its main-agent
// wire.jsonl is read later by ledger.rs.
fn kimi_sessions(cwd: &str) -> Vec<String> {
    let Some(root) = home().map(|h| h.join(".kimi-code").join("sessions")) else { return vec![] };
    let Ok(workspaces) = fs::read_dir(root) else { return vec![] };
    let mut items = Vec::new();
    for workspace in workspaces.flatten() {
        let Ok(sessions) = fs::read_dir(workspace.path()) else { continue };
        for session in sessions.flatten() {
            let state = session.path().join("state.json");
            let Ok(text) = fs::read_to_string(&state) else { continue };
            let Ok(meta) = serde_json::from_str::<Value>(&text) else { continue };
            if meta.get("workDir").and_then(Value::as_str) != Some(cwd) { continue; }
            let name = session.file_name().to_string_lossy().strip_prefix("session_").map(str::to_string);
            let Some(name) = name else { continue };
            let mtime = fs::metadata(&state).ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
            items.push((mtime, name));
        }
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.into_iter().map(|(_, id)| id).collect()
}

fn collect_jsonl(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { collect_jsonl(&path, out); }
        else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") { out.push(path); }
    }
}

// ---- harness-trace: cross-harness session enumeration for the trace panel ----
// One row per interactive session across all four stores, no cwd filter. The
// frontend row model adds from/why (mail-ledger join happens there); this struct
// is HarnessTraceRow minus those two fields. All fns take `home` as a parameter
// so tests can point them at a temp/nonexistent HOME.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTraceRow {
    pub id: String,
    pub harness: &'static str,
    pub session_id: String,
    pub ts: String,            // start time, ISO UTC ("" when unknown)
    pub last_activity: String, // ISO UTC from store mtime/db
    pub status: &'static str,  // live | idle | done | dead
    pub cwd: String,           // tildified
    // CONTRACT2: claude subagent children carry the parent session id + "subagent";
    // other harnesses stay None here (the frontend mail join may attach "dispatch").
    pub parent_id: Option<String>,
    pub parent_kind: Option<&'static str>,
}

const TRACE_LIVE_MS: u64 = 2 * 60 * 1000;
const TRACE_IDLE_MS: u64 = 60 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Unix ms -> ISO-8601 UTC. Civil-from-days per Howard Hinnant's date algorithms;
// hand-rolled because the crate graph has no date dependency and this is the
// only formatter needed.
fn ms_to_iso(ms: u64) -> String {
    if ms == 0 {
        return String::new();
    }
    let secs = (ms / 1000) as i64;
    let day_secs = secs.rem_euclid(86_400);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_secs / 3600,
        (day_secs % 3600) / 60,
        day_secs % 60,
        ms % 1000
    )
}

// dead = the session's cwd no longer exists (deleted worktree); otherwise bucket
// by recency of last store write. Thresholds: live <= 2m, idle <= 1h, else done.
fn trace_status(cwd: &str, last_ms: u64, now: u64) -> &'static str {
    if !cwd.is_empty() && !Path::new(cwd).is_dir() {
        return "dead";
    }
    let age = now.saturating_sub(last_ms);
    if age <= TRACE_LIVE_MS {
        "live"
    } else if age <= TRACE_IDLE_MS {
        "idle"
    } else {
        "done"
    }
}

fn tildify(path: &str, home: &Path) -> String {
    match home.to_str().and_then(|h| path.strip_prefix(h)) {
        Some(rest) if rest.is_empty() => "~".to_string(),
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_string(),
    }
}

fn trace_row(
    harness: &'static str,
    session_id: String,
    ts: String,
    last_ms: u64,
    cwd: &str,
    home: &Path,
    now: u64,
) -> (u64, HarnessTraceRow) {
    trace_row_with_parent(harness, session_id, ts, last_ms, cwd, home, now, None, None)
}

fn trace_row_with_parent(
    harness: &'static str,
    session_id: String,
    ts: String,
    last_ms: u64,
    cwd: &str,
    home: &Path,
    now: u64,
    parent_id: Option<String>,
    parent_kind: Option<&'static str>,
) -> (u64, HarnessTraceRow) {
    (
        last_ms,
        HarnessTraceRow {
            id: session_id.clone(),
            harness,
            session_id,
            ts,
            last_activity: ms_to_iso(last_ms),
            status: trace_status(cwd, last_ms, now),
            cwd: tildify(cwd, home),
            parent_id,
            parent_kind,
        },
    )
}

// Read the leading transcript records of a claude jsonl: the first cwd-bearing
// record yields the session cwd + start ts; a sidechain marker, when present,
// is reused (the duel filter's evidence) to keep the top-level walk excluding
// subagent transcripts.
fn read_claude_transcript(path: &Path) -> (String, String, bool) {
    let mut cwd = String::new();
    let mut ts = String::new();
    let mut sidechain = false;
    if let Ok(file) = fs::File::open(path) {
        // Leading lines can be summary records without cwd; scan a few.
        for line in BufReader::new(file).lines().take(10).flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                sidechain = true;
                break;
            }
            if let Some(dir) = v.get("cwd").and_then(Value::as_str) {
                cwd = dir.to_string();
                ts = v
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                break;
            }
        }
    }
    (cwd, ts, sidechain)
}

// CONTRACT2: the top-level walk still drops sidechains (the duel filter rule,
// superseded per CONTRACT2 tree law — they return below as children). The
// subagent walk re-emits them as child seeds under <project>/<parentSessionId>/
// subagents/agent-*.jsonl, parent_id = the parent session id.
fn trace_claude(home: &Path, now: u64) -> Vec<(u64, HarnessTraceRow)> {
    let projects = home.join(".claude").join("projects");
    let Ok(project_dirs) = fs::read_dir(&projects) else { return vec![] };
    let mut out = Vec::new();
    for project in project_dirs.flatten() {
        let Ok(sessions) = fs::read_dir(project.path()) else { continue };
        for entry in sessions.flatten() {
            let path = entry.path();
            let name = entry
                .file_name()
                .to_str()
                .unwrap_or("")
                .to_string();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                let (cwd, ts, sidechain) = read_claude_transcript(&path);
                if sidechain {
                    continue;
                }
                out.push(trace_row_with_parent(
                    "claude", id.to_string(), ts, mtime_ms(&path), &cwd, home, now, None, None,
                ));
            } else if path.is_dir() {
                // <parentSessionId>/subagents/agent-*.jsonl
                let subdir = path.join("subagents");
                let Ok(subagents) = fs::read_dir(&subdir) else { continue };
                for sub in subagents.flatten() {
                    let sp = sub.path();
                    if !sp.is_file() || sp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(id) = sp.file_stem().and_then(|s| s.to_str()) else { continue };
                    let (cwd, ts, _sidechain) = read_claude_transcript(&sp);
                    out.push(trace_row_with_parent(
                        "claude",
                        id.to_string(),
                        ts,
                        mtime_ms(&sp),
                        &cwd,
                        home,
                        now,
                        Some(name.clone()),
                        Some("subagent"),
                    ));
                }
            }
        }
    }
    out
}

fn trace_opencode(home: &Path, now: u64) -> Vec<(u64, HarnessTraceRow)> {
    let db = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, directory, time_created, time_updated FROM session \
         WHERE time_archived IS NULL ORDER BY time_updated DESC",
    ) else {
        return vec![];
    };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)? as u64,
            row.get::<_, i64>(3)? as u64,
        ))
    });
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .map(|(id, dir, created, updated)| {
            trace_row("opencode", id, ms_to_iso(created), updated, &dir, home, now)
        })
        .collect()
}

fn trace_codex(home: &Path, now: u64) -> Vec<(u64, HarnessTraceRow)> {
    let root = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files);
    let mut out = Vec::new();
    for path in files {
        let Ok(file) = fs::File::open(&path) else { continue };
        let Some(Ok(line)) = BufReader::new(file).lines().next() else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let meta = if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            v.get("payload").unwrap_or(&v)
        } else {
            continue;
        };
        let Some(id) = meta.get("id").and_then(Value::as_str) else { continue };
        let cwd = meta.get("cwd").and_then(Value::as_str).unwrap_or("");
        let ts = meta
            .get("timestamp")
            .or_else(|| v.get("timestamp"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        out.push(trace_row("codex", id.to_string(), ts, mtime_ms(&path), cwd, home, now));
    }
    out
}

fn trace_kimi(home: &Path, now: u64) -> Vec<(u64, HarnessTraceRow)> {
    let root = home.join(".kimi-code").join("sessions");
    let Ok(workspaces) = fs::read_dir(&root) else { return vec![] };
    let mut out = Vec::new();
    for workspace in workspaces.flatten() {
        let Ok(sessions) = fs::read_dir(workspace.path()) else { continue };
        for session in sessions.flatten() {
            let state = session.path().join("state.json");
            let Ok(text) = fs::read_to_string(&state) else { continue };
            let Ok(meta) = serde_json::from_str::<Value>(&text) else { continue };
            let cwd = meta.get("workDir").and_then(Value::as_str).unwrap_or("");
            let name = session
                .file_name()
                .to_string_lossy()
                .strip_prefix("session_")
                .map(str::to_string);
            let Some(id) = name else { continue };
            let created = fs::metadata(&state)
                .ok()
                .and_then(|m| m.created().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(trace_row("kimi", id, ms_to_iso(created), mtime_ms(&state), cwd, home, now));
        }
    }
    out
}

// Every session across the four stores, newest activity first.
fn trace_rows(home: &Path) -> Vec<HarnessTraceRow> {
    let now = now_ms();
    let mut keyed: Vec<(u64, HarnessTraceRow)> = Vec::new();
    keyed.extend(trace_claude(home, now));
    keyed.extend(trace_opencode(home, now));
    keyed.extend(trace_codex(home, now));
    keyed.extend(trace_kimi(home, now));
    keyed.sort_by(|a, b| b.0.cmp(&a.0));
    keyed.into_iter().map(|(_, row)| row).collect()
}

#[tauri::command]
pub fn harness_trace_rows() -> Vec<HarnessTraceRow> {
    match home() {
        Some(h) => trace_rows(&h),
        None => vec![],
    }
}

// Newest-first list of resumable session ids for a cwd. Callers that just want the
// single latest take the first element (harness_session below).
#[tauri::command]
pub fn harness_sessions(tool: String, cwd: String) -> Vec<String> {
    // `tool` is the launch command's first token (claude/opencode); strip a path
    // so "/usr/local/bin/claude" still matches.
    let bin = tool.rsplit('/').next().unwrap_or(&tool);
    match bin {
        "claude" => claude_sessions(&cwd),
        "opencode" => opencode_sessions(&cwd),
        "codex" => codex_sessions(&cwd),
        "kimi" => kimi_sessions(&cwd),
        _ => vec![],
    }
}

#[tauri::command]
pub fn harness_session(tool: String, cwd: String) -> Option<String> {
    harness_sessions(tool, cwd).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    // S1 sabotage receipt: a HOME with no harness stores (nonexistent dir) must
    // yield an empty list from every reader and the aggregate, never an error.
    #[test]
    fn trace_rows_from_nonexistent_home_is_empty() {
        let home = Path::new("/nonexistent-home-for-harness-trace-test");
        assert!(trace_claude(home, 0).is_empty());
        assert!(trace_opencode(home, 0).is_empty());
        assert!(trace_codex(home, 0).is_empty());
        assert!(trace_kimi(home, 0).is_empty());
        assert!(trace_rows(home).is_empty());
    }

    #[test]
    fn ms_to_iso_formats_utc() {
        assert_eq!(ms_to_iso(0), "");
        assert_eq!(ms_to_iso(1_722_470_400_000), "2024-08-01T00:00:00.000Z");
        assert_eq!(ms_to_iso(1_722_470_461_500), "2024-08-01T00:01:01.500Z");
    }

    #[test]
    fn trace_status_buckets() {
        let now = 10_000_000;
        // Empty cwd never reads as dead (unknown cwd stays time-bucketed).
        assert_eq!(trace_status("", now - 1000, now), "live");
        assert_eq!(trace_status("/", now - 30 * 60 * 1000, now), "idle");
        assert_eq!(trace_status("/", now - 2 * 60 * 60 * 1000, now), "done");
        assert_eq!(trace_status("/nonexistent-cwd-x", now, now), "dead");
    }

    #[test]
    fn tildify_replaces_home_prefix() {
        let home = Path::new("/Users/someone");
        assert_eq!(tildify("/Users/someone/projects/a", home), "~/projects/a");
        assert_eq!(tildify("/Users/someone", home), "~");
        assert_eq!(tildify("/Users/someoneelse/x", home), "/Users/someoneelse/x");
    }

    // CONTRACT2 proof #2: a fake <project>/<parent>/subagents/agent-x.jsonl in a
    // fixture HOME yields a child seed carrying parent_id = the parent session id.
    #[test]
    fn claude_subagent_child_carries_parent_id() {
        let home = std::env::temp_dir().join(format!("dock-strip-harness-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let project = home.join(".claude").join("projects").join("home-projects-x");
        let parent_id = "parent-session-1";
        let subdir = project.join(parent_id).join("subagents");
        fs::create_dir_all(&subdir).unwrap();
        fs::write(
            project.join(format!("{parent_id}.jsonl")),
            r#"{"cwd":"/Users/t/home/projects/x","timestamp":"2026-08-02T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            subdir.join("agent-1234.jsonl"),
            r#"{"isSidechain":true,"cwd":"/Users/t/home/projects/x","timestamp":"2026-08-02T00:05:00Z"}"#,
        )
        .unwrap();

        let rows = trace_claude(&home, now_ms());
        let children: Vec<_> = rows.iter().filter(|r| r.1.parent_id.is_some()).collect();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].1.session_id, "agent-1234");
        assert_eq!(children[0].1.harness, "claude");
        assert_eq!(children[0].1.parent_id.as_deref(), Some(parent_id));
        assert_eq!(children[0].1.parent_kind, Some("subagent"));

        let tops: Vec<_> = rows.iter().filter(|r| r.1.parent_id.is_none()).collect();
        assert_eq!(tops.len(), 1);
        assert_eq!(tops[0].1.session_id, parent_id);

        fs::remove_dir_all(&home).ok();
    }
}
