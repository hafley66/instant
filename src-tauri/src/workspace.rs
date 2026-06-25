// Workspaces ("Spaces"): one git worktree + branch + chosen agent. This is the
// generic cmux-style primitive — a Space is just (worktree path, agent command),
// and opening it is `open_session` with cwd=path, command=agent. The registry is
// persisted to app_data_dir/workspaces.json so Spaces survive restarts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// GUI apps don't inherit the login PATH, so git/worktree tooling needs this.
const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,     // "<repo-basename>-<branch>"
    pub repo: String,   // the main checkout
    pub branch: String, // worktree branch (created off HEAD)
    pub path: String,   // the worktree dir (where the agent runs)
    pub agent: String,  // "claude" | "opencode" | ...
    pub created: u64,   // unix seconds
}

#[derive(Default)]
pub struct Workspaces(pub Mutex<Vec<Workspace>>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("workspaces.json"))
}

/// Read the persisted registry (empty on first run / parse error).
pub fn load(app: &AppHandle) -> Vec<Workspace> {
    let Ok(path) = store_path(app) else { return Vec::new() };
    let Ok(bytes) = fs::read(path) else { return Vec::new() };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save(app: &AppHandle, list: &[Workspace]) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Run a git command in `repo`; Ok(stdout) on success, Err(stderr) on failure.
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{EXTRA_PATH}:{p}"),
        Err(_) => EXTRA_PATH.to_string(),
    };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("PATH", path)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(p)
        .to_string()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub fn list_workspaces(store: State<Workspaces>) -> Vec<Workspace> {
    store.0.lock().unwrap().clone()
}

/// Create a worktree+branch off the repo's HEAD and register it.
#[tauri::command]
pub fn create_workspace(
    app: AppHandle,
    store: State<Workspaces>,
    repo: String,
    branch: String,
    agent: String,
) -> Result<Workspace, String> {
    let repo_path = Path::new(&repo);
    // Must be a git work tree.
    git(repo_path, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| format!("{repo} is not a git repository"))?;

    // Sanitize the branch for the dir-name component: a branch like
    // "../../etc" would otherwise let the join escape .worktrees. The real git
    // branch arg below keeps the original name (slashes are valid there).
    let id = format!("{}-{}", basename(&repo), branch.replace(['/', '\\'], "-"));
    // Worktrees live in a sibling .worktrees dir so they don't clutter the repo.
    let parent = repo_path.parent().ok_or("repo has no parent dir")?;
    let path = parent.join(".worktrees").join(&id);
    let path_str = path.to_string_lossy().to_string();

    git(
        repo_path,
        &["worktree", "add", "-b", &branch, &path_str, "HEAD"],
    )?;

    let ws = Workspace {
        id: id.clone(),
        repo,
        branch,
        path: path_str,
        agent,
        created: now(),
    };

    let snapshot = {
        let mut list = store.0.lock().unwrap();
        list.retain(|w| w.id != ws.id);
        list.push(ws.clone());
        save(&app, &list)?;
        list.clone()
    };
    let _ = app.emit("workspaces-changed", snapshot);
    Ok(ws)
}

/// Forget a Space; optionally remove its worktree from disk.
#[tauri::command]
pub fn remove_workspace(
    app: AppHandle,
    store: State<Workspaces>,
    id: String,
    delete_tree: bool,
) -> Result<(), String> {
    let target = store.0.lock().unwrap().iter().find(|w| w.id == id).cloned();
    if let Some(ws) = target {
        if delete_tree {
            // Best-effort: a dirty worktree needs --force; ignore failures so the
            // registry entry still goes away.
            let _ = git(
                Path::new(&ws.repo),
                &["worktree", "remove", "--force", &ws.path],
            );
        }
    }
    let snapshot = {
        let mut list = store.0.lock().unwrap();
        list.retain(|w| w.id != id);
        save(&app, &list)?;
        list.clone()
    };
    let _ = app.emit("workspaces-changed", snapshot);
    Ok(())
}
