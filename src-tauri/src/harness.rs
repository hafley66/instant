// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd, non-alnum->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

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
    let Some(id) = boop_harness::HarnessId::parse(&tool) else {
        return vec![];
    };
    crate::harness_store::session_ids(id, &cwd)
}

#[tauri::command]
pub async fn harness_session(tool: String, cwd: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        harness_sessions_blocking(tool, cwd).into_iter().next()
    })
    .await
    .unwrap_or_default()
}
