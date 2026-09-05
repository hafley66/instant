// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Session discovery lives in boop-harness; this only
// maps a harness tag to its newest resumable id.

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
    boop_harness::Registry::discover().session_ids_for_cwd(id, &cwd)
}

#[tauri::command]
pub async fn harness_session(tool: String, cwd: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        harness_sessions_blocking(tool, cwd).into_iter().next()
    })
    .await
    .unwrap_or_default()
}
