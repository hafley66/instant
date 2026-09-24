// ⌘-click resolution lives in boop-harness (`boop_harness::click`); these are
// the renderer-facing commands over it.

use boop_harness::click::{self, ClickCell, ResolveResult};

pub async fn resolve_ref_impl(
    token: String,
    cwd: String,
    sessions: Option<Vec<String>>,
    cell: Option<ClickCell>,
) -> Result<ResolveResult, String> {
    let cell = cell.map(|cell| ClickCell {
        socket: cell.socket.or_else(|| std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty())),
        ..cell
    });
    tauri::async_runtime::spawn_blocking(move || {
        click::resolve_click(&token, cell.as_ref(), &cwd, &sessions.unwrap_or_default()).result
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn repo_root(path: String) -> Option<String> {
    click::repo_root_of(&path)
}

/// The bytes of a path at a revision, for a file the working tree does not hold.
#[tauri::command]
pub async fn read_git_blob(repo: String, rev: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        click::git_out(&repo, &["show", &format!("{rev}:{path}")]).ok_or_else(|| format!("{path} is not in {rev}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clear_ref_index() {
    click::clear_index_cache();
}
