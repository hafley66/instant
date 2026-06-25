// Resolve the latest resumable session id for an AI harness in a given cwd, so
// the UI can launch `claude --resume <id>` / `opencode --session <id>` instead
// of a blank conversation. Each harness keys its sessions by working directory;
// we read that mapping straight from its on-disk store (no harness invocation):
//   - claude:   ~/.claude/projects/<cwd with '/'->'-'>/<uuid>.jsonl, newest mtime
//   - opencode: ~/.local/share/opencode/opencode.db, session table by directory
// Returns None when no session exists (fresh worktree) -> caller launches blank.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// claude encodes the project dir by replacing every '/' with '-' (leading slash
// becomes a leading '-'), then stores one <session-uuid>.jsonl per conversation.
fn latest_claude_session(cwd: &str) -> Option<String> {
    let enc = cwd.replace('/', "-");
    let dir = home()?.join(".claude").join("projects").join(enc);
    let mut newest: Option<(SystemTime, String)> = None;
    for entry in fs::read_dir(&dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mtime = entry.metadata().ok().and_then(|m| m.modified().ok());
        let mtime = match mtime {
            Some(t) => t,
            None => continue,
        };
        if newest.as_ref().map_or(true, |(t, _)| mtime > *t) {
            newest = Some((mtime, stem));
        }
    }
    newest.map(|(_, id)| id)
}

// opencode stores sessions in a SQLite db; `session.directory` is the plain cwd.
// time_archived IS NULL filters out deleted/archived sessions.
fn latest_opencode_session(cwd: &str) -> Option<String> {
    let db = home()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.query_row(
        "SELECT id FROM session \
         WHERE directory = ?1 AND time_archived IS NULL \
         ORDER BY time_updated DESC LIMIT 1",
        [cwd],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[tauri::command]
pub fn harness_session(tool: String, cwd: String) -> Option<String> {
    // `tool` is the launch command's first token (claude/opencode); strip a path
    // so "/usr/local/bin/claude" still matches.
    let bin = tool.rsplit('/').next().unwrap_or(&tool);
    match bin {
        "claude" => latest_claude_session(&cwd),
        "opencode" => latest_opencode_session(&cwd),
        _ => None,
    }
}
