// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd, non-alnum->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// claude encodes the project dir by replacing every non-alphanumeric char with
// '-' (so '/', '.', '_', space all collapse to '-'; a '.worktrees' segment turns
// into '-worktrees'), then stores one <session-uuid>.jsonl per conversation.
// Returns every session id in the cwd, NEWEST FIRST (mtime desc) — the caller
// disambiguates when several tabs share a cwd.
// opencode stores sessions in a SQLite db; `session.directory` is the plain cwd.
// time_archived IS NULL filters out deleted/archived sessions. Newest first.
// Codex CLI stores rollout JSONL files under ~/.codex/sessions/<Y>/<M>/<D>.
// The first session_meta record carries the authoritative cwd and id; scan only
// metadata, keeping this probe cheap enough for tab/session discovery.
// Kimi Code stores sessions as ~/.kimi-code/sessions/<workspace>/session_<id>/.
// The state file carries the workspace and update timestamp; only its main-agent
// wire.jsonl is read later by ledger.rs.
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
    // CONTRACT2: claude/codex subagent children carry the parent session id +
    // "subagent"; others stay None (the frontend mail join may attach "dispatch").
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

// Every session across the four stores, newest activity first.
fn trace_rows(home: &Path) -> Vec<HarnessTraceRow> {
    let now = now_ms();
    let mut keyed: Vec<(u64, HarnessTraceRow)> = [
        crate::harness_store::HarnessId::Claude,
        crate::harness_store::HarnessId::Opencode,
        crate::harness_store::HarnessId::Codex,
        crate::harness_store::HarnessId::Kimi,
    ]
    .into_iter()
    .flat_map(|id| crate::harness_store::sessions(home, id, None))
    .map(|session| {
        let row = HarnessTraceRow {
            id: session.id.clone(),
            harness: session.harness,
            session_id: session.id,
            ts: ms_to_iso(session.created_at_ms),
            last_activity: ms_to_iso(session.last_activity_ms),
            status: trace_status(&session.cwd, session.last_activity_ms, now),
            cwd: tildify(&session.cwd, home),
            parent_id: session.parent_id,
            parent_kind: session.parent_kind,
        };
        (session.last_activity_ms, row)
    })
    .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0));
    keyed.into_iter().map(|(_, row)| row).collect()
}

#[tauri::command]
pub async fn harness_trace_rows() -> Vec<HarnessTraceRow> {
    tauri::async_runtime::spawn_blocking(harness_trace_rows_blocking)
        .await
        .unwrap_or_default()
}

fn harness_trace_rows_blocking() -> Vec<HarnessTraceRow> {
    match home() {
        Some(h) => trace_rows(&h),
        None => vec![],
    }
}

// Newest-first list of resumable session ids for a cwd. Callers that just want the
// single latest take the first element (harness_session below).
#[tauri::command]
pub async fn harness_sessions(tool: String, cwd: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || harness_sessions_blocking(tool, cwd))
        .await
        .unwrap_or_default()
}

fn harness_sessions_blocking(tool: String, cwd: String) -> Vec<String> {
    let (Some(home), Some(id)) = (home(), crate::harness_store::HarnessId::parse(&tool)) else {
        return vec![];
    };
    crate::harness_store::sessions(&home, id, Some(&cwd))
        .into_iter()
        .map(|session| session.id)
        .collect()
}

#[tauri::command]
pub async fn harness_session(tool: String, cwd: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        harness_sessions_blocking(tool, cwd).into_iter().next()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // S1 sabotage receipt: a HOME with no harness stores (nonexistent dir) must
    // yield an empty list from every reader and the aggregate, never an error.
    #[test]
    fn trace_rows_from_nonexistent_home_is_empty() {
        let home = Path::new("/nonexistent-home-for-harness-trace-test");
        for id in [
            crate::harness_store::HarnessId::Claude,
            crate::harness_store::HarnessId::Opencode,
            crate::harness_store::HarnessId::Codex,
            crate::harness_store::HarnessId::Kimi,
        ] {
            assert!(crate::harness_store::sessions(home, id, None).is_empty());
        }
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
        assert_eq!(
            tildify("/Users/someoneelse/x", home),
            "/Users/someoneelse/x"
        );
    }

    // Defect receipt 2026-08-04: guardian rollout read as top-level = 2 shells for 1 pane.
    #[test]
    fn codex_subagent_thread_carries_parent_id() {
        let home = std::env::temp_dir().join(format!("dock-strip-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let day = home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("08")
            .join("04");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-a.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"main-1","cwd":"/","thread_source":"user","timestamp":"2026-08-04T00:00:00Z"}}"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-b.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"guard-1","parent_thread_id":"main-1","cwd":"/","thread_source":"subagent","timestamp":"2026-08-04T00:00:00Z"}}"#,
        )
        .unwrap();
        let rows =
            crate::harness_store::sessions(&home, crate::harness_store::HarnessId::Codex, None);
        let main = rows.iter().find(|r| r.id == "main-1").unwrap();
        let guard = rows.iter().find(|r| r.id == "guard-1").unwrap();
        assert_eq!(main.parent_id, None);
        assert_eq!(main.parent_kind, None);
        assert_eq!(guard.parent_id.as_deref(), Some("main-1"));
        assert_eq!(guard.parent_kind, Some("subagent"));
        let _ = fs::remove_dir_all(&home);
    }

    // CONTRACT2 proof #2: a fake <project>/<parent>/subagents/agent-x.jsonl in a
    // fixture HOME yields a child seed carrying parent_id = the parent session id.
    #[test]
    fn claude_subagent_child_carries_parent_id() {
        let home = std::env::temp_dir().join(format!("dock-strip-harness-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let project = home
            .join(".claude")
            .join("projects")
            .join("home-projects-x");
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

        let rows =
            crate::harness_store::sessions(&home, crate::harness_store::HarnessId::Claude, None);
        let children: Vec<_> = rows.iter().filter(|r| r.parent_id.is_some()).collect();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, "agent-1234");
        assert_eq!(children[0].harness, "claude");
        assert_eq!(children[0].parent_id.as_deref(), Some(parent_id));
        assert_eq!(children[0].parent_kind, Some("subagent"));

        let tops: Vec<_> = rows.iter().filter(|r| r.parent_id.is_none()).collect();
        assert_eq!(tops.len(), 1);
        assert_eq!(tops[0].id, parent_id);

        fs::remove_dir_all(&home).ok();
    }
}
