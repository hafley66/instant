use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::harness_store::HarnessSession;

fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn created(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn first_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .take(8)
        .map_while(Result::ok)
        .find_map(|line| serde_json::from_str(&line).ok())
}

fn claude_file(path: &Path, parent_id: Option<String>) -> Option<HarnessSession> {
    let value = first_json(path)?;
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) && parent_id.is_none() {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_string();
    let cwd = value.get("cwd").and_then(Value::as_str)?.to_string();
    let created_at_ms = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(crate::ledger::iso_to_ms)
        .unwrap_or(0);
    Some(HarnessSession {
        id,
        harness: "claude",
        cwd,
        source_path: Some(path.to_string_lossy().into_owned()),
        title: None,
        model: None,
        input_tokens: None,
        parent_kind: parent_id.as_ref().map(|_| "subagent"),
        parent_id,
        created_at_ms,
        last_activity_ms: modified(path),
    })
}

pub fn claude(home: &Path) -> Vec<HarnessSession> {
    let Ok(projects) = fs::read_dir(home.join(".claude/projects")) else {
        return vec![];
    };
    let mut rows = Vec::new();
    for project in projects.flatten() {
        let Ok(entries) = fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                rows.extend(claude_file(&path, None));
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            let parent = entry.file_name().to_string_lossy().to_string();
            let Ok(subagents) = fs::read_dir(path.join("subagents")) else {
                continue;
            };
            for subagent in subagents.flatten() {
                rows.extend(claude_file(&subagent.path(), Some(parent.clone())));
            }
        }
    }
    rows
}

pub fn opencode(home: &Path) -> Vec<HarnessSession> {
    let db = home.join(".local/share/opencode/opencode.db");
    let Ok(conn) = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let sql = "SELECT id,directory,title,time_created,time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok(HarnessSession {
            id: row.get(0)?,
            harness: "opencode",
            cwd: row.get(1)?,
            source_path: None,
            title: row.get(2)?,
            model: None,
            input_tokens: None,
            parent_id: None,
            parent_kind: None,
            created_at_ms: row.get::<_, i64>(3)? as u64,
            last_activity_ms: row.get::<_, i64>(4)? as u64,
        })
    }) else {
        return vec![];
    };
    rows.flatten().collect()
}

pub fn codex(home: &Path) -> Vec<HarnessSession> {
    let db = home.join(".codex/state_5.sqlite");
    let Ok(conn) = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let sql = "SELECT t.id,t.cwd,t.rollout_path,t.created_at_ms,t.updated_at_ms,e.parent_thread_id FROM threads t LEFT JOIN thread_spawn_edges e ON e.child_thread_id=t.id WHERE t.archived=0 ORDER BY t.updated_at_ms DESC,t.id DESC";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |row| {
        let parent_id: Option<String> = row.get(5)?;
        Ok(HarnessSession {
            id: row.get(0)?,
            harness: "codex",
            cwd: row.get(1)?,
            source_path: row.get::<_, Option<String>>(2)?,
            title: None,
            model: None,
            input_tokens: None,
            parent_kind: parent_id.as_ref().map(|_| "subagent"),
            parent_id,
            created_at_ms: row.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
            last_activity_ms: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as u64,
        })
    }) else {
        return vec![];
    };
    rows.flatten().collect()
}

pub fn kimi(home: &Path) -> Vec<HarnessSession> {
    let Ok(workspaces) = fs::read_dir(home.join(".kimi-code/sessions")) else {
        return vec![];
    };
    let mut rows = Vec::new();
    for workspace in workspaces.flatten() {
        let Ok(sessions) = fs::read_dir(workspace.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let path = session.path();
            let state = path.join("state.json");
            let Some(meta) = fs::read_to_string(&state)
                .ok()
                .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            else {
                continue;
            };
            let Some(id) = session
                .file_name()
                .to_string_lossy()
                .strip_prefix("session_")
                .map(str::to_string)
            else {
                continue;
            };
            let wire = path.join("agents/main/wire.jsonl");
            rows.push(HarnessSession {
                id,
                harness: "kimi",
                cwd: meta
                    .get("workDir")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                source_path: Some(wire.to_string_lossy().into_owned()),
                title: None,
                model: None,
                input_tokens: None,
                parent_id: None,
                parent_kind: None,
                created_at_ms: created(&state),
                last_activity_ms: modified(&state).max(modified(&wire)),
            });
        }
    }
    rows
}
