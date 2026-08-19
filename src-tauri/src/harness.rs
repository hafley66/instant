// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd, non-alnum->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

use std::path::PathBuf;

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
    crate::harness_store::session_ids(&home, id, &cwd)
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
    use std::fs;

    // Defect receipt 2026-08-04: guardian rollout read as top-level = 2 shells for 1 pane.
    #[test]
    fn codex_subagent_thread_carries_parent_id() {
        let home = std::env::temp_dir().join(format!("harness-codex-{}", std::process::id()));
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
        let home = std::env::temp_dir().join(format!("harness-store-{}", std::process::id()));
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
