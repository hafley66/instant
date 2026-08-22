use boop_store::ident::{Store, TurnQuery};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct BoopTurn {
    pub session: String,
    pub harness: String,
    pub turn: i64,
    pub ts: i64,
    pub role: String,
    pub said: String,
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

fn boop_db_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BOOP_DB").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Store::default_path().map_err(|error| error.to_string())
}

fn open_store_ro() -> Result<Store, String> {
    let path = boop_db_path()?;
    Store::open_readonly(path).map_err(|error| error.to_string())
}

fn open_store_rw() -> Result<Store, String> {
    let path = boop_db_path()?;
    Store::open(path).map_err(|error| error.to_string())
}

fn read_turns(session: &str) -> Result<Vec<BoopTurn>, String> {
    let store = open_store_ro()?;
    let query = TurnQuery {
        session: Some(session.to_string()),
        ..Default::default()
    };
    let rows = store.turn_rows(&query).map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| BoopTurn {
            session: row.session,
            harness: row.harness,
            turn: row.turn,
            ts: row.ts,
            role: row.role,
            said: row.said,
        })
        .collect())
}

fn read_recent_turns(since: i64, harness: &str) -> Result<Vec<BoopTurn>, String> {
    let store = open_store_ro()?;
    let query = TurnQuery {
        since: if since > 0 { Some(since as u64) } else { None },
        harness: if !harness.is_empty() { Some(harness.to_string()) } else { None },
        role: Some("assistant".to_string()),
        limit: Some(100),
        ..Default::default()
    };
    let rows = store.turn_rows(&query).map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| BoopTurn {
            session: row.session,
            harness: row.harness,
            turn: row.turn,
            ts: row.ts,
            role: row.role,
            said: row.said,
        })
        .collect())
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
        .await
        .map_err(|error| error.to_string())?
}

fn add_favorite(turn: &BoopTurn) -> Result<(), String> {
    let store = open_store_rw()?;
    let source = format!("turn:{}:{}", turn.session, turn.turn);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    store
        .favorite_add(&turn.said, "", &source, now)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_favorites() -> Result<Vec<BoopFavorite>, String> {
    let store = open_store_ro()?;
    let rows = store.query_favorites(None).map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(|row| serde_json::from_value(row).map_err(|error| error.to_string()))
        .collect()
}

fn remove_favorite_source(source: &str) -> Result<(), String> {
    let store = open_store_rw()?;
    store
        .connection()
        .execute("DELETE FROM agent_favorite WHERE source=?1", [source])
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

    #[test]
    fn direct_store_reads_live_boop_database() {
        let store = open_store_ro();
        assert!(store.is_ok(), "boop store opens read-only from default path");
        let store = store.unwrap();
        let turns = store.turn_rows(&TurnQuery {
            limit: Some(5),
            ..Default::default()
        });
        assert!(turns.is_ok(), "turn_rows query succeeds directly against boop-store");
    }
}
