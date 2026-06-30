// Discover EXISTING git worktrees across many repo clones under a set of roots,
// flattened into table rows. The hard part is N clones of the same origin: a
// linked worktree and its main checkout share a git-common-dir, so we dedupe
// clones by that, then group rows by remote.origin.url in the UI. Read-only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// Heavy/uninteresting dirs we never descend into. NOT .worktrees — that's where
// worktrees often live.
const SKIP: &[&str] = &[
    "node_modules", "target", ".git", "Library", ".cache", ".cargo", ".rustup",
    ".npm", ".Trash", "dist", "build", ".next", "vendor", "Pictures", "Music",
];

#[derive(Serialize, Clone)]
pub struct WorktreeRow {
    pub origin: String,   // remote.origin.url — groups clones of the same repo
    pub clone: String,    // the clone's main worktree path
    pub worktree: String, // this worktree's path
    pub branch: String,   // branch name, or (detached)/(bare)
    pub head: String,     // short sha
    pub is_main: bool,    // primary worktree vs linked
    pub dirty: bool,      // has uncommitted changes
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{EXTRA_PATH}:{p}"),
        Err(_) => EXTRA_PATH.to_string(),
    };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
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

/// Add a git worktree for `branch` under the checkout `repo`. If `branch`
/// already exists it is checked out; otherwise it is created off HEAD. The
/// worktree dir is `<parent>/.worktrees/<repo-basename>-<branch>` (matching the
/// Spaces convention). Returns the new worktree path; the caller rescans.
#[tauri::command]
pub fn add_worktree(repo: String, branch: String) -> Result<String, String> {
    let repo_path = Path::new(&repo);
    git(repo_path, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| format!("{repo} is not a git repository"))?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name is empty".into());
    }
    let id = format!("{}-{}", basename(&repo), branch.replace('/', "-"));
    let parent = repo_path.parent().ok_or("repo has no parent dir")?;
    let path = parent.join(".worktrees").join(&id);
    let path_str = path.to_string_lossy().to_string();
    // Existing branch -> plain checkout; else create it off HEAD.
    if git(repo_path, &["worktree", "add", &path_str, branch]).is_err() {
        git(repo_path, &["worktree", "add", "-b", branch, &path_str, "HEAD"])?;
    }
    Ok(path_str)
}

/// Unified working-tree diff for a worktree (or any checkout): staged + unstaged
/// changes against HEAD, plus a list of untracked files appended as a note. The
/// frontend renders it with shiki's `diff` grammar. Read-only.
#[tauri::command]
pub fn git_diff(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    git(p, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| format!("{path} is not a git repository"))?;
    let diff = git(p, &["diff", "HEAD", "--no-color"])?;
    let untracked = git(p, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    let mut out = diff;
    if !untracked.trim().is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str("# untracked files\n");
        for f in untracked.lines() {
            out.push_str("+ ");
            out.push_str(f);
            out.push('\n');
        }
    }
    Ok(out)
}

/// Remove a linked git worktree. Runs from the main checkout `repo` so a linked
/// worktree is removable even when the cwd is elsewhere. `force` passes
/// `--force` (drops uncommitted changes); without it git refuses a dirty tree.
/// The main worktree cannot be removed. Caller rescans on success.
#[tauri::command]
pub fn remove_worktree(repo: String, worktree: String, force: bool) -> Result<(), String> {
    let repo_path = Path::new(&repo);
    if std::fs::canonicalize(&repo).ok() == std::fs::canonicalize(&worktree).ok() {
        return Err("cannot remove the main worktree".into());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&worktree);
    git(repo_path, &args).map(|_| ())
}

fn expand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix('~') {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest.trim_start_matches('/'));
        }
    }
    PathBuf::from(p)
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

// Collect git locations. A repo stops recursion (its worktrees come from git,
// not the filesystem walk), keeping this fast.
fn walk(dir: &Path, depth: usize, max: usize, out: &mut Vec<PathBuf>) {
    if depth > max {
        return;
    }
    if is_repo(dir) {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        if SKIP.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        walk(&p, depth + 1, max, out);
    }
}

/// Scan `roots` (default ["~/projects"]) for git worktrees, one row each.
#[tauri::command]
pub fn scan_worktrees(roots: Vec<String>, max_depth: Option<usize>) -> Vec<WorktreeRow> {
    let max = max_depth.unwrap_or(4);
    let roots = if roots.is_empty() {
        vec!["~/projects".to_string()]
    } else {
        roots
    };

    let mut candidates = Vec::new();
    for r in &roots {
        walk(&expand(r), 0, max, &mut candidates);
    }

    // Dedupe clones by canonical git-common-dir; keep one probe dir per clone.
    let mut clones: BTreeMap<String, PathBuf> = BTreeMap::new();
    for c in candidates {
        let Ok(common) = git(&c, &["rev-parse", "--git-common-dir"]) else { continue };
        let abs = if Path::new(&common).is_absolute() {
            PathBuf::from(&common)
        } else {
            c.join(&common)
        };
        let key = std::fs::canonicalize(&abs)
            .unwrap_or(abs)
            .to_string_lossy()
            .to_string();
        clones.entry(key).or_insert(c);
    }

    let mut rows = Vec::new();
    for probe in clones.values() {
        rows.extend(worktree_rows_for_clone(probe));
    }
    rows
}

/// `git worktree list --porcelain` for one clone, parsed into a row per
/// worktree (main + linked). `probe` is any path inside the clone. Shared by
/// `scan_worktrees` (walks many clones) and `worktree_at` (resolves one path
/// on demand, e.g. a live tmux session's cwd the walk never reached).
fn worktree_rows_for_clone(probe: &Path) -> Vec<WorktreeRow> {
    let Ok(porcelain) = git(probe, &["worktree", "list", "--porcelain"]) else { return Vec::new() };
    // Porcelain: blocks separated by a blank line; first block is the main worktree.
    let blocks: Vec<&str> = porcelain.split("\n\n").filter(|b| !b.trim().is_empty()).collect();
    let main_path = blocks
        .first()
        .and_then(|b| b.lines().find_map(|l| l.strip_prefix("worktree ")))
        .unwrap_or("")
        .to_string();
    let origin =
        git(Path::new(&main_path), &["config", "--get", "remote.origin.url"]).unwrap_or_default();

    let mut rows = Vec::new();
    for block in blocks {
        let mut wt = String::new();
        let mut head = String::new();
        let mut branch = String::new();
        for line in block.lines() {
            if let Some(v) = line.strip_prefix("worktree ") {
                wt = v.to_string();
            } else if let Some(v) = line.strip_prefix("HEAD ") {
                head = v.chars().take(8).collect();
            } else if let Some(v) = line.strip_prefix("branch ") {
                branch = v.trim_start_matches("refs/heads/").to_string();
            } else if line == "detached" {
                branch = "(detached)".to_string();
            } else if line == "bare" {
                branch = "(bare)".to_string();
            }
        }
        if wt.is_empty() {
            continue;
        }
        let dirty = git(Path::new(&wt), &["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        rows.push(WorktreeRow {
            origin: origin.clone(),
            clone: main_path.clone(),
            worktree: wt.clone(),
            branch,
            head,
            is_main: wt == main_path,
            dirty,
        });
    }
    rows
}

/// Resolve the single git worktree a path sits in, without a directory walk —
/// `scan_worktrees` only finds checkouts under its configured roots, so a live
/// tmux session sitting in a clone outside those roots (or one made after the
/// last scan) is otherwise invisible to the worktree tree/chips. The frontend
/// calls this on demand for any session cwd that didn't match a scanned row.
/// None when `path` isn't inside a git work tree.
#[tauri::command]
pub fn worktree_at(path: String) -> Option<WorktreeRow> {
    let p = Path::new(&path);
    git(p, &["rev-parse", "--is-inside-work-tree"]).ok()?;
    let canon_target = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    worktree_rows_for_clone(p).into_iter().find(|r| {
        let wt_canon = std::fs::canonicalize(&r.worktree).unwrap_or_else(|_| PathBuf::from(&r.worktree));
        canon_target == wt_canon || canon_target.starts_with(&wt_canon)
    })
}
