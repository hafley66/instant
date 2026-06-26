// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd, non-alnum->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

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
        _ => vec![],
    }
}

#[tauri::command]
pub fn harness_session(tool: String, cwd: String) -> Option<String> {
    harness_sessions(tool, cwd).into_iter().next()
}
