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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopSyncStat {
    found: bool,
    written: u64,
    dropped: u64,
    usage_written: u64,
    usage_updated: u64,
}

/// The singular refresh hit first; an id the store never projected (`/clear`
/// mints one) falls back to one filtered discovery pass.
fn candidate_for(
    adapter: &dyn boop_harness::Harness,
    known: &boop_harness::KnownSessions,
    session: &str,
) -> Result<Option<boop_harness::SessionRef>, String> {
    if let Some(hit) = adapter
        .sync_candidate(known, session)
        .map_err(|error| error.to_string())?
    {
        return Ok(Some(hit));
    }
    Ok(adapter
        .sync_candidates(known)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|candidate| candidate.session_id == session))
}

fn sync_session(session: &str, harness: &str) -> Result<BoopSyncStat, String> {
    let store = open_store_rw()?;
    let known = store.known_sessions().map_err(|error| error.to_string())?;
    let registry = boop_harness::Registry::discover();
    let adapter = registry
        .by_name(harness)
        .ok_or_else(|| format!("unknown harness `{harness}`"))?;
    let Some(candidate) = candidate_for(adapter, &known, session)? else {
        return Ok(BoopSyncStat {
            found: false,
            written: 0,
            dropped: 0,
            usage_written: 0,
            usage_updated: 0,
        });
    };
    store.begin().map_err(|error| error.to_string())?;
    match boop_harness::sync_session(&store, adapter, &candidate) {
        Ok(stat) => {
            store.commit().map_err(|error| error.to_string())?;
            Ok(BoopSyncStat {
                found: true,
                written: stat.written,
                dropped: stat.dropped,
                usage_written: stat.usage_written,
                usage_updated: stat.usage_updated,
            })
        }
        Err(error) => {
            let _ = store.rollback();
            Err(error.to_string())
        }
    }
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
pub async fn boop_sync_session(session: String, harness: String) -> Result<BoopSyncStat, String> {
    tauri::async_runtime::spawn_blocking(move || sync_session(&session, &harness))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turns_recent(since: i64, harness: String) -> Result<Vec<BoopTurn>, String> {
    tauri::async_runtime::spawn_blocking(move || read_recent_turns(since, &harness))
        .await
        .map_err(|error| error.to_string())?
}

// Boop panel reads. agent_route is the registry every lane spawn writes
// into; liveness comes from the store's session view, not the route table.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopLane {
    pub route: String,
    pub kind: String,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub goal: Option<String>,
    pub parent: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub registered_ms: i64,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopLaneEvent {
    pub ts: i64,
    pub kind: String,
    pub from_route: String,
    pub to_route: String,
    pub preview: String,
}

// agent_live keeps idle rows for panes that died long ago (28 of 29 lanes
// measured); liveness reads the tmux server. Routes carry either a session
// name or a pane id (%NNN), so both id shapes are collected.
fn tmux_live_ids() -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for format in ["#{session_name}", "#{pane_id}"] {
        let output = crate::pty::tmux_cmd()
            .args(["list-panes", "-a", "-F", format])
            .env("PATH", crate::pty::path_env())
            .output();
        if let Ok(out) = output {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                ids.insert(line.to_string());
            }
        }
    }
    ids
}

fn read_lanes() -> Result<Vec<BoopLane>, String> {
    let store = open_store_ro()?;
    let mut statement = store
        .connection()
        .prepare(
            "SELECT r.route, r.kind, r.harness, r.model, r.goal, r.parent, r.cwd,
                    r.tmux, r.worktree_dir,
                    CAST(strftime('%s', r.registered_at) AS INTEGER) * 1000
                      + CAST(substr(r.registered_at, 21, 3) AS INTEGER),
                    (SELECT CASE WHEN l.pid IS NOT NULL THEN 1 ELSE 0 END
                       FROM agent_live l
                       JOIN dict_session ds ON ds.id = l.session_id
                      WHERE ds.value = r.session_id)
               FROM agent_route r
              ORDER BY r.registered_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                BoopLane {
                    route: row.get(0)?,
                    kind: row.get(1)?,
                    harness: row.get(2)?,
                    model: row.get(3)?,
                    goal: row.get(4)?,
                    parent: row.get(5)?,
                    cwd: row.get(6)?,
                    branch: row
                        .get::<_, Option<String>>(8)?
                        .as_deref()
                        .and_then(|dir| dir.trim_end_matches('/').rsplit('/').next())
                        .map(str::to_string),
                    registered_ms: row.get(9)?,
                    state: String::new(),
                },
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(10)?.unwrap_or(0),
            ))
        })
        .map_err(|error| error.to_string())?;
    let sessions = tmux_live_ids();
    let mut lanes = Vec::new();
    for row in rows {
        let (mut lane, tmux, live_pid) = row.map_err(|error| error.to_string())?;
        lane.state = if tmux.as_deref().is_some_and(|name| sessions.contains(name)) || live_pid == 1
        {
            "open"
        } else {
            "closed"
        }
        .to_string();
        lanes.push(lane);
    }
    Ok(lanes)
}

fn read_lane_events(since_ms: i64) -> Result<Vec<BoopLaneEvent>, String> {
    let store = open_store_ro()?;
    let mut statement = store
        .connection()
        .prepare(
            "SELECT ts, kind, from_route, to_route, preview FROM (
               SELECT CAST(strftime('%s', m.from_timestamp) AS INTEGER) * 1000
                        + CAST(substr(m.from_timestamp, 21, 3) AS INTEGER) AS ts,
                      m.kind AS kind, m.from_route AS from_route,
                      m.to_route AS to_route,
                      substr(replace(m.body, char(10), ' '), 1, 120) AS preview
                 FROM agent_mail m
                WHERE ?1 <= 0 OR ?1 <= CAST(strftime('%s', m.from_timestamp) AS INTEGER) * 1000
                                  + CAST(substr(m.from_timestamp, 21, 3) AS INTEGER)
             ) ORDER BY ts",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([since_ms], |row| {
            Ok(BoopLaneEvent {
                ts: row.get(0)?,
                kind: row.get(1)?,
                from_route: row.get(2)?,
                to_route: row.get(3)?,
                preview: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|error| error.to_string())?);
    }
    Ok(events)
}

#[tauri::command]
pub async fn boop_lanes() -> Result<Vec<BoopLane>, String> {
    tauri::async_runtime::spawn_blocking(read_lanes)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_lane_events(since_ms: i64) -> Result<Vec<BoopLaneEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || read_lane_events(since_ms))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopTurnCommentTarget {
    pub session: String,
    pub turn: i64,
    #[serde(default)]
    pub role: String,
    /// The assistant turn that answered a sent comment, off
    /// agent_turn_comment_reply; absent while pending or un-ingested.
    #[serde(default)]
    pub reply_turn: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopTurnComment {
    pub client_id: String,
    pub kind: String,
    pub quote: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub tab_name: Option<String>,
    pub targets: Vec<BoopTurnCommentTarget>,
    #[serde(default)]
    pub created_ts: i64,
    #[serde(default)]
    pub updated_ts: i64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn comment_to_wire(row: boop_store::ident::TurnComment) -> BoopTurnComment {
    BoopTurnComment {
        client_id: row.client_id,
        kind: row.kind,
        quote: row.quote,
        note: row.note,
        enabled: row.enabled,
        tab_name: row.tab_name,
        targets: row
            .targets
            .into_iter()
            .map(|target| BoopTurnCommentTarget {
                session: target.session,
                turn: target.turn,
                role: target.role,
                reply_turn: target.reply_turn,
            })
            .collect(),
        created_ts: row.created_ts,
        updated_ts: row.updated_ts,
    }
}

fn targets_any_of(row: &boop_store::ident::TurnComment, sessions: &[String]) -> bool {
    row.targets
        .iter()
        .any(|target| sessions.iter().any(|session| *session == target.session))
}

/// Pending comments whose tab or target session matches the caller; a comment
/// with neither key is invisible everywhere, so it never strands.
fn read_turn_comments(tab: &str, sessions: &[String]) -> Result<Vec<BoopTurnComment>, String> {
    let store = open_store_ro()?;
    let rows = store
        .turn_comments_pending()
        .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| row.tab_name.as_deref() == Some(tab) || targets_any_of(row, sessions))
        .map(comment_to_wire)
        .collect())
}

/// Sent comments targeting any of the caller's sessions: the annotations a
/// terminal paints back onto the turns they quote, each with the reply turn
/// it drew.
fn read_turn_annotations(sessions: &[String]) -> Result<Vec<BoopTurnComment>, String> {
    let store = open_store_ro()?;
    let rows = store
        .turn_comments_sent()
        .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| targets_any_of(row, sessions))
        .map(comment_to_wire)
        .collect())
}

#[tauri::command]
pub async fn boop_turn_annotations(sessions: Vec<String>) -> Result<Vec<BoopTurnComment>, String> {
    tauri::async_runtime::spawn_blocking(move || read_turn_annotations(&sessions))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turn_comments(
    tab: String,
    sessions: Vec<String>,
) -> Result<Vec<BoopTurnComment>, String> {
    tauri::async_runtime::spawn_blocking(move || read_turn_comments(&tab, &sessions))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turn_comment_upsert(comment: BoopTurnComment) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store_rw()?;
        let targets: Vec<(String, i64)> = comment
            .targets
            .iter()
            .map(|target| (target.session.clone(), target.turn))
            .collect();
        store
            .turn_comment_upsert(&boop_store::ident::TurnCommentUpsert {
                client_id: &comment.client_id,
                kind: &comment.kind,
                quote: &comment.quote,
                note: comment.note.as_deref(),
                enabled: comment.enabled,
                tab_name: comment.tab_name.as_deref(),
                targets: &targets,
                ts: now_ms(),
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turn_comment_delete(client_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store_rw()?;
        store
            .turn_comment_delete(&client_id)
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn boop_turn_comments_sent(client_ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store_rw()?;
        store
            .turn_comment_mark_sent(&client_ids, now_ms())
            .map_err(|error| error.to_string())?;
        Ok(())
    })
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
    fn lane_reads_live_boop_database() {
        let lanes = read_lanes();
        assert!(
            lanes.is_ok(),
            "read_lanes succeeds against the live store: {:?}",
            lanes.err()
        );
        let lanes = lanes.unwrap();
        assert!(!lanes.is_empty(), "agent_route has registered lanes");
        assert!(
            lanes.iter().all(|lane| lane.state == "open" || lane.state == "closed"),
            "every lane reports an open/closed state"
        );
        let events = read_lane_events(0);
        assert!(
            events.is_ok(),
            "read_lane_events succeeds against the live store: {:?}",
            events.err()
        );
        let events = events.unwrap();
        assert!(
            events.windows(2).all(|pair| pair[0].ts <= pair[1].ts),
            "lane events come back ordered by ts"
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

    mod candidate_for {
        use super::super::candidate_for;
        use std::path::PathBuf;
        use boop_harness::{
            Capabilities, Harness, HarnessId, KnownSession, KnownSessions, LanePolicy, MailPolicy,
            ReadChunk, SessionRef, VariantSupport,
        };

        static CAPS: Capabilities = Capabilities {
            bans_plan_family_models: false,
            lanes: LanePolicy::Allowed,
            variant: VariantSupport::None,
            mail: MailPolicy::Door,
            native_tui_projector: false,
            wrapper_owns_alternate_screen: false,
        };

        struct Scan(Vec<SessionRef>);

        impl Harness for Scan {
            fn id(&self) -> HarnessId {
                HarnessId::Claude
            }
            fn capabilities(&self) -> &'static Capabilities {
                &CAPS
            }
            fn sessions(&self) -> anyhow::Result<Vec<SessionRef>> {
                Ok(self.0.clone())
            }
            fn read_from(&self, _: &SessionRef, _: u64) -> anyhow::Result<ReadChunk> {
                Ok(ReadChunk {
                    events: vec![],
                    next_offset: 0,
                    reset: false,
                    skipped: 0,
                })
            }
        }

        fn reference(session_id: &str, path: &str) -> SessionRef {
            SessionRef {
                harness: HarnessId::Claude,
                session_id: session_id.to_owned(),
                nickname: session_id.to_owned(),
                path: path.into(),
                cwd: None,
                git_branch: None,
                modified_ms: 0,
                size: 0,
                tmux: None,
                tmux_socket: None,
                parent: None,
            }
        }

        #[test]
        fn an_unknown_id_is_found_by_the_discovery_fallback() {
            let adapter = Scan(vec![
                reference("older-session", "/tmp/older.jsonl"),
                reference("fresh-after-clear", "/tmp/fresh.jsonl"),
            ]);
            let found = candidate_for(&adapter, &KnownSessions::new(), "fresh-after-clear")
                .unwrap()
                .expect("discovery must insert the unknown id");
            assert_eq!(found.path, PathBuf::from("/tmp/fresh.jsonl"));
        }

        #[test]
        fn a_known_id_refreshes_without_the_fallback() {
            let path = std::env::temp_dir().join(format!(
                "boop_sync_candidate_{}_known.jsonl",
                std::process::id()
            ));
            std::fs::write(&path, "{}\n").unwrap();
            let mut known = KnownSessions::new();
            known.insert(
                path.clone(),
                KnownSession {
                    harness: "claude".to_owned(),
                    session_id: "known-session".to_owned(),
                    nickname: "known-session".to_owned(),
                    cwd: None,
                    git_branch: None,
                    parent: None,
                    cursor: 0,
                    modified_ms: 0,
                    projection_version: 0,
                },
            );
            let adapter = Scan(vec![]);
            let found = candidate_for(&adapter, &known, "known-session")
                .unwrap()
                .expect("the known id refreshes from the store record");
            assert_eq!(found.path, path);
            let _ = std::fs::remove_file(&path);
        }

        #[test]
        fn an_id_nowhere_stays_not_found() {
            let adapter = Scan(vec![reference("older-session", "/tmp/older.jsonl")]);
            assert!(candidate_for(&adapter, &KnownSessions::new(), "gone").unwrap().is_none());
        }
    }
}

/// What the pane's agent sessions have touched, for the ⌘-click resolver:
/// every file path the ledger recorded (newest first) and every directory
/// those paths sit under, plus each session's launch cwd. A token the agent
/// printed almost always names something on this list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentEvidence {
    pub paths: Vec<String>,
    pub dirs: Vec<String>,
}

const EVIDENCE_PATH_CAP: usize = 2000;

pub fn agent_evidence(sessions: &[String], boundary: &str) -> AgentEvidence {
    if sessions.is_empty() {
        return AgentEvidence::default();
    }
    let Ok(store) = open_store_ro() else {
        return AgentEvidence::default();
    };
    let connection = store.connection();
    let placeholders: Vec<String> = (0..sessions.len())
        .map(|index| format!("(s.value = ?{n} OR s.value LIKE ?{n} || '/%')", n = index + 1))
        .collect();
    let filter = placeholders.join(" OR ");
    let params: Vec<rusqlite::types::Value> = sessions
        .iter()
        .map(|session| rusqlite::types::Value::Text(session.clone()))
        .collect();
    let mut paths: Vec<String> = Vec::new();
    if let Ok(mut statement) = connection.prepare(&format!(
        "SELECT p.value FROM agent_touch t
           JOIN dict_path p ON p.id = t.path_id
           JOIN dict_session s ON s.id = t.session_id
          WHERE {filter}
          ORDER BY t.ts DESC, t.turn DESC LIMIT {EVIDENCE_PATH_CAP}"
    )) {
        if let Ok(rows) = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, String>(0)) {
            for path in rows.flatten() {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
    }
    let mut cwds: Vec<String> = Vec::new();
    if let Ok(mut statement) = connection.prepare(&format!(
        "SELECT c.value FROM agent_session a
           JOIN dict_session s ON s.id = a.session_id
           JOIN dict_cwd c ON c.id = a.cwd_id
          WHERE {filter}"
    )) {
        if let Ok(rows) = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, String>(0)) {
            cwds.extend(rows.flatten());
        }
    }
    AgentEvidence { dirs: evidence_dirs(&paths, &cwds, boundary), paths }
}

/// Distinct directories above each touched path up to `boundary`, newest
/// evidence first, then the session cwds. Order is the retry order.
pub fn evidence_dirs(paths: &[String], cwds: &[String], boundary: &str) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |dir: String| {
        if !dir.is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    let boundary = boundary.trim_end_matches('/');
    for path in paths {
        let mut current = std::path::Path::new(path).parent();
        while let Some(dir) = current {
            let text = dir.to_string_lossy();
            if text.len() <= boundary.len() || !text.starts_with(boundary) {
                break;
            }
            push(text.into_owned());
            current = dir.parent();
        }
    }
    for cwd in cwds {
        push(cwd.trim_end_matches('/').to_string());
    }
    dirs
}
