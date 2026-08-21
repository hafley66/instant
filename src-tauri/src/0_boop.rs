use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BoopTurn {
    session: String,
    harness: String,
    turn: i64,
    ts: i64,
    role: String,
    said: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BoopFavorite {
    favorite_id: i64,
    note: String,
    source: String,
    created_ts: i64,
    bytes: i64,
    body: String,
}

fn read_turns(session: &str) -> Result<Vec<BoopTurn>, String> {
    let output = std::process::Command::new("boop")
        .args(["db", "turn", "list", "--session", session, "--format", "ndjson"])
        .env("PATH", crate::pty::path_env())
        .output()
        .map_err(|error| format!("boop db turn list: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("boop turn row: {error}")))
        .collect()
}

fn read_recent_turns(since: i64, harness: &str) -> Result<Vec<BoopTurn>, String> {
    let output = Command::new("boop")
        .args(["db", "turn", "list", "--since", &since.to_string(), "--harness", harness,
            "--role", "assistant", "--limit", "100", "--format", "ndjson"])
        .env("PATH", crate::pty::path_env()).output()
        .map_err(|error| format!("boop recent turn list: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    String::from_utf8_lossy(&output.stdout).lines().filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("boop recent turn row: {error}")))
        .collect()
}

#[tauri::command]
pub async fn boop_turns(session: String) -> Result<Vec<BoopTurn>, String> {
    tauri::async_runtime::spawn_blocking(move || read_turns(&session))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turns_recent(since: i64, harness: String) -> Result<Vec<BoopTurn>, String> {
    tauri::async_runtime::spawn_blocking(move || read_recent_turns(since, &harness))
        .await.map_err(|error| error.to_string())?
}

fn add_favorite(turn: &BoopTurn) -> Result<(), String> {
    let source = format!("turn:{}:{}", turn.session, turn.turn);
    let mut child = Command::new("boop")
        .args(["db", "favorite", "add", "--source", &source])
        .env("PATH", crate::pty::path_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("boop db favorite add: {error}"))?;
    child.stdin.take().ok_or("boop favorite stdin unavailable")?
        .write_all(turn.said.as_bytes())
        .map_err(|error| format!("boop favorite stdin: {error}"))?;
    let output = child.wait_with_output().map_err(|error| format!("boop favorite wait: {error}"))?;
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

fn read_favorites() -> Result<Vec<BoopFavorite>, String> {
    let output = Command::new("boop")
        .args(["db", "favorite", "list", "--format", "ndjson"])
        .env("PATH", crate::pty::path_env())
        .output()
        .map_err(|error| format!("boop db favorite list: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("boop favorite row: {error}")))
        .collect()
}

fn boop_db_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BOOP_DB").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".agent").join("boop.db"))
        .ok_or("HOME unavailable for Boop database".to_string())
}

fn remove_favorite_source(source: &str) -> Result<(), String> {
    let connection = rusqlite::Connection::open(boop_db_path()?).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM agent_favorite WHERE source=?1", [source])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn boop_favorite_add(turn: BoopTurn) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || add_favorite(&turn))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_favorites() -> Result<Vec<BoopFavorite>, String> {
    tauri::async_runtime::spawn_blocking(read_favorites)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_favorite_toggle(turn: BoopTurn) -> Result<Vec<BoopFavorite>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = format!("turn:{}:{}", turn.session, turn.turn);
        if read_favorites()?.iter().any(|favorite| favorite.source == source) {
            remove_favorite_source(&source)?;
        } else {
            add_favorite(&turn)?;
        }
        read_favorites()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boop_turn_shape_matches_cli_ndjson() {
        let row: BoopTurn = serde_json::from_str(
            r#"{"session":"s1","harness":"codex","turn":4,"ts":9,"role":"assistant","said":"answer"}"#,
        )
        .unwrap();
        assert_eq!(row.session, "s1");
        assert_eq!(row.turn, 4);
        assert_eq!(row.said, "answer");
    }
}
