use boop_store::ident::{Store, TurnQuery};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct BoopTurn {
    pub session: String,
    pub harness: String,
    pub turn: i64,
    pub ts: i64,
    pub role: String,
    pub said: String,
    #[serde(default = "unknown_session_scope")]
    pub session_scope: String,
    #[serde(default)]
    pub parent_session: Option<String>,
}

fn unknown_session_scope() -> String {
    "unknown".to_owned()
}

fn live_relations(harness: &str) -> HashMap<String, (String, Option<String>)> {
    let registry = boop_harness::Registry::discover();
    let Some(adapter) = registry.by_name(harness) else {
        return HashMap::new();
    };
    adapter
        .live()
        .live_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|session| {
            let scope = match session.scope {
                boop_harness::live::LiveSessionScope::Root => "root",
                boop_harness::live::LiveSessionScope::Child => "child",
                boop_harness::live::LiveSessionScope::Unknown => "unknown",
            };
            (
                session.session_id,
                (scope.to_owned(), session.parent_session),
            )
        })
        .collect()
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

/// Turn visibility matches the visible pane against recent turns; a session's
/// full history (2806 rows / 9.4MB measured 2026-08-22) re-read on every scan
/// was instant's top CPU cost. Read only the newest window.
const TURN_WINDOW: u64 = 300;

fn read_turns(session: &str) -> Result<Vec<BoopTurn>, String> {
    let store = open_store_ro()?;
    let last_turn: Option<u64> = store
        .connection()
        .query_row(
            "SELECT MAX(t.turn) FROM agent_turn t
             WHERE t.session_id = (SELECT id FROM dict_session WHERE value = ?1)",
            [session],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|error| error.to_string())?
        .map(|turn| turn.max(0) as u64);
    let query = TurnQuery {
        session: Some(session.to_string()),
        turn_from: last_turn.map(|turn| turn.saturating_sub(TURN_WINDOW)),
        ..Default::default()
    };
    let rows = store.turn_rows(&query).map_err(|error| error.to_string())?;
    let relations = rows
        .first()
        .map(|row| live_relations(&row.harness))
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|row| {
            let (session_scope, parent_session) = relations
                .get(&row.session)
                .cloned()
                .unwrap_or_else(|| (unknown_session_scope(), None));
            BoopTurn {
                session: row.session,
                harness: row.harness,
                turn: row.turn,
                ts: row.ts,
                role: row.role,
                said: row.said,
                session_scope,
                parent_session,
            }
        })
        .collect())
}

fn read_recent_turns(since: i64, harness: &str) -> Result<Vec<BoopTurn>, String> {
    let store = open_store_ro()?;
    let query = TurnQuery {
        since: if since > 0 { Some(since as u64) } else { None },
        harness: if !harness.is_empty() {
            Some(harness.to_string())
        } else {
            None
        },
        role: Some("assistant".to_string()),
        limit: Some(100),
        ..Default::default()
    };
    let rows = store.turn_rows(&query).map_err(|error| error.to_string())?;
    let relations = live_relations(harness);
    Ok(rows
        .into_iter()
        .map(|row| {
            let (session_scope, parent_session) = relations
                .get(&row.session)
                .cloned()
                .unwrap_or_else(|| (unknown_session_scope(), None));
            BoopTurn {
                session: row.session,
                harness: row.harness,
                turn: row.turn,
                ts: row.ts,
                role: row.role,
                said: row.said,
                session_scope,
                parent_session,
            }
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
        // `BoopFavorite` reads `note` as a plain String, so `None` would write
        // a NULL that fails to deserialize back.
        .favorite_add(&turn.said, Some(""), &source, now)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_favorites() -> Result<Vec<BoopFavorite>, String> {
    let store = open_store_ro()?;
    let rows = store
        .query_favorites(None)
        .map_err(|error| error.to_string())?;
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
        if read_favorites()?
            .iter()
            .any(|favorite| favorite.source == source)
        {
            remove_favorite_source(&source)?;
        } else {
            add_favorite(&turn)?;
        }
        read_favorites()
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One rendered row range, already joined across wrapped screen lines by the
/// frontend, since only xterm knows which rows continue which.
#[derive(Clone, Debug, Deserialize)]
pub struct LogicalLine {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedTurn {
    pub session: String,
    pub harness: String,
    pub turn: i64,
    pub ts: i64,
    pub role: String,
    pub said: String,
    pub id: String,
    pub buffer_start: usize,
    pub buffer_end: usize,
    pub anchor_start: usize,
    pub anchor_end: usize,
    pub confidence: &'static str,
}

fn locate_turns(lines: Vec<LogicalLine>, turns: Vec<BoopTurn>) -> Vec<LocatedTurn> {
    let registry = boop_harness::Registry::discover();
    let harness = turns
        .iter()
        .max_by_key(|turn| turn.ts)
        .map(|turn| turn.harness.as_str());
    let input = harness
        .and_then(|name| registry.by_name(name))
        .and_then(|adapter| {
            let rows = lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>();
            adapter.terminal_input_region(&rows)
        });
    let lines: Vec<boop_turnvis::LogicalLine> = lines
        .into_iter()
        .enumerate()
        .filter(|(index, _)| {
            input.is_none_or(|region| *index < region.start || *index > region.end)
        })
        .map(|(_, line)| boop_turnvis::LogicalLine {
            text: line.text,
            start: line.start,
            end: line.end,
        })
        .collect();
    let turns: Vec<boop_turnvis::BoopTurn> = turns
        .into_iter()
        .map(|turn| boop_turnvis::BoopTurn {
            session: turn.session,
            harness: turn.harness,
            turn: turn.turn,
            ts: turn.ts,
            role: turn.role,
            said: turn.said,
        })
        .collect();
    boop_turnvis::locate_visible_turns(&lines, &turns)
        .into_iter()
        .map(|found| LocatedTurn {
            session: found.session,
            harness: found.harness,
            turn: found.turn,
            ts: found.ts,
            role: found.role,
            said: found.said,
            id: found.id,
            buffer_start: found.buffer_start,
            buffer_end: found.buffer_end,
            anchor_start: found.anchor_start,
            anchor_end: found.anchor_end,
            confidence: match found.confidence {
                boop_turnvis::Confidence::Anchored => "anchored",
                boop_turnvis::Confidence::Extended => "extended",
            },
        })
        .collect()
}

/// The match is a quadratic dynamic program per turn over a 300-turn window,
/// so it runs off the IPC thread even though it touches no store and no IO.
#[tauri::command]
pub async fn boop_locate_turns(
    lines: Vec<LogicalLine>,
    turns: Vec<BoopTurn>,
) -> Result<Vec<LocatedTurn>, String> {
    tauri::async_runtime::spawn_blocking(move || locate_turns(lines, turns))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The IPC boundary is where a correct matcher still ships wrong data: a
    /// missed rename or a dropped field reads as an empty pane, never a crash.
    #[test]
    fn locate_turns_serializes_to_the_shape_the_frontend_golden_records() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../labs/turn-identity/fixtures"
        );
        let fixtures = [
            ("claude", "claude"),
            ("claude-wide", "claude"),
            ("claude-narrow", "claude"),
            ("codex", "codex"),
            ("ccz", "ccz"),
            ("opencode", "opencode"),
            ("kimi", "kimi"),
        ];
        for (capture_name, turns_name) in fixtures {
            let capture: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{capture_name}.json")).unwrap(),
            )
            .unwrap();
            let lines: Vec<LogicalLine> = serde_json::from_value(capture["lines"].clone()).unwrap();
            let turns: Vec<BoopTurn> = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{turns_name}.turns.json")).unwrap(),
            )
            .unwrap();
            let golden: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{capture_name}.golden.json")).unwrap(),
            )
            .unwrap();

            let located = serde_json::to_value(locate_turns(lines, turns)).unwrap();
            let want = golden["turns"].as_array().unwrap();
            let got = located.as_array().unwrap();
            assert_eq!(got.len(), want.len(), "{capture_name}: turn count");
            for (index, (got, want)) in got.iter().zip(want).enumerate() {
                for field in [
                    "id",
                    "turn",
                    "role",
                    "confidence",
                    "anchorStart",
                    "anchorEnd",
                    "bufferStart",
                    "bufferEnd",
                ] {
                    assert_eq!(got[field], want[field], "{capture_name}[{index}] {field}");
                }
            }
        }
    }

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
    fn native_locator_excludes_the_live_codex_composer() {
        let lines = vec![
            LogicalLine {
                text: "› submitted prompt".into(),
                start: 20,
                end: 20,
            },
            LogicalLine {
                text: "assistant answer".into(),
                start: 21,
                end: 21,
            },
            LogicalLine {
                text: "› draft prompt".into(),
                start: 22,
                end: 22,
            },
            LogicalLine {
                text: "gpt-5.6-sol · ~/projects · Approve for me · Context 40%".into(),
                start: 23,
                end: 23,
            },
        ];
        let turns = vec![
            BoopTurn {
                session: "parent".into(),
                harness: "codex".into(),
                turn: 1,
                ts: 1,
                role: "user".into(),
                said: "submitted prompt".into(),
                session_scope: "root".into(),
                parent_session: None,
            },
            BoopTurn {
                session: "parent".into(),
                harness: "codex".into(),
                turn: 2,
                ts: 2,
                role: "assistant".into(),
                said: "assistant answer".into(),
                session_scope: "root".into(),
                parent_session: None,
            },
            BoopTurn {
                session: "parent".into(),
                harness: "codex".into(),
                turn: 3,
                ts: 3,
                role: "user".into(),
                said: "draft prompt".into(),
                session_scope: "root".into(),
                parent_session: None,
            },
        ];
        let located = locate_turns(lines, turns);
        assert_eq!(
            located
                .iter()
                .map(|turn| (
                    turn.turn,
                    turn.role.as_str(),
                    turn.anchor_start,
                    turn.anchor_end
                ))
                .collect::<Vec<_>>(),
            vec![(1, "user", 20, 20), (2, "assistant", 21, 21)]
        );
    }

    #[test]
    fn direct_store_reads_live_boop_database() {
        let store = open_store_ro();
        assert!(
            store.is_ok(),
            "boop store opens read-only from default path"
        );
        let store = store.unwrap();
        let turns = store.turn_rows(&TurnQuery {
            limit: Some(5),
            ..Default::default()
        });
        assert!(
            turns.is_ok(),
            "turn_rows query succeeds directly against boop-store"
        );
    }
}
