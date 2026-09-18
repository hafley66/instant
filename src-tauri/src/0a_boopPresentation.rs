//! Claude's usage-only response rows preserve token accounting but contain no
//! conversational block. Older store projections label them `assistant`.
//! Resolve that stored provenance for presentation without changing the ledger.
use boop_store::{ident::Store, rows::TurnRow};
use std::collections::HashSet;

pub(super) fn classify(store: &Store, rows: &mut [TurnRow]) -> Result<(), String> {
    for row in rows.iter_mut().filter(|row| row.role == "user") {
        let content = boop_turnvis::boop_content(&row.said);
        if content.len() != row.said.len() {
            if content.is_empty() {
                row.role = "meta".into();
            }
            row.said = content.to_owned();
        }
    }
    let candidates: Vec<_> = rows
        .iter()
        .filter(|row| row.harness == "claude" && row.role == "assistant" && row.said.is_empty())
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let values = candidates
        .iter()
        .enumerate()
        .map(|(index, _)| format!("(?{},?{})", index * 2 + 1, index * 2 + 2))
        .collect::<Vec<_>>()
        .join(",");
    let params: Vec<rusqlite::types::Value> = candidates
        .iter()
        .flat_map(|row| {
            [
                rusqlite::types::Value::Text(row.session.clone()),
                rusqlite::types::Value::Integer(row.turn),
            ]
        })
        .collect();
    let mut statement = store
        .connection()
        .prepare(&format!(
            "WITH candidate(session,turn) AS (VALUES {values})
         SELECT candidate.session,candidate.turn FROM candidate
         JOIN dict_session s ON s.value=candidate.session
         JOIN agent_usage u ON u.session_id=s.id AND u.turn=candidate.turn"
        ))
        .map_err(|error| error.to_string())?;
    let usage_only: HashSet<(String, i64)> = statement
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    for row in rows {
        if usage_only.contains(&(row.session.clone(), row.turn)) {
            row.role = "thinking".to_owned();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use boop_store::ident::{project_transcript, sync_session_with, TurnQuery};

    #[test]
    fn boop_envelopes_change_presentation_only() {
        let scratch = tempfile::tempdir().unwrap();
        let store = Store::open(scratch.path().join("boop.db")).unwrap();
        let texts = [
            "[boop m1 from coordinator]\nactual user content\nsecond line",
            "[boop m2 from feature/tls]",
            "[ordinary brackets] actual content",
            "<system-reminder>injected text</system-reminder>",
            "<user-data>keep this</user-data>",
        ];
        let raw: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(index, text)| TurnRow {
                session: "fixture".into(),
                harness: "claude".into(),
                turn: index as i64 + 1,
                ts: 0,
                role: "user".into(),
                said: (*text).into(),
            })
            .collect();
        let mut shown = raw.clone();
        classify(&store, &mut shown).unwrap();
        assert_eq!(
            shown
                .iter()
                .map(|row| (row.role.as_str(), row.said.as_str()))
                .collect::<Vec<_>>(),
            [
                ("user", "actual user content\nsecond line"),
                ("meta", ""),
                ("user", texts[2]),
                ("user", texts[3]),
                ("user", texts[4]),
            ]
        );
        assert_eq!(
            raw.iter().map(|row| row.said.as_str()).collect::<Vec<_>>(),
            texts
        );
    }

    #[test]
    fn claude_mixed_blocks_preserve_text_tools_and_usage_provenance() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("claude.jsonl");
        std::fs::write(
            &path,
            include_str!("../../fixtures/transcripts/provider/1_claude-mixed-records.jsonl"),
        )
        .unwrap();
        let store = Store::open(scratch.path().join("boop.db")).unwrap();
        let session = boop_harness::SessionRef {
            harness: boop_harness::HarnessId::Claude,
            session_id: "fixture".into(),
            nickname: "fixture".into(),
            path,
            cwd: None,
            git_branch: None,
            modified_ms: 0,
            size: 0,
            tmux: None,
            tmux_socket: None,
            parent: None,
        };
        sync_session_with(&store, &session, None, 0, |store, session, cursor| {
            project_transcript(store, session, cursor.offset)
        })
        .unwrap();
        let mut rows = store
            .turn_rows(&TurnQuery {
                session: Some("fixture".into()),
                ..Default::default()
            })
            .unwrap();
        classify(&store, &mut rows).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| (row.turn, row.role.as_str(), row.said.as_str()))
                .collect::<Vec<_>>(),
            [
                (1, "user", "okay now try"),
                (2, "thinking", ""),
                (3, "tool", "mcp__bewpp__browser_status"),
                (4, "tool", "mcp__bewpp__tabs_list"),
                (5, "thinking", ""),
                (6, "tool", "mcp__bewpp__page_navigate"),
                (7, "thinking", ""),
                (8, "tool", "Bash"),
                (
                    9,
                    "assistant",
                    "Blocked at the extension. Navigation requires site permission."
                ),
                (10, "assistant", "Reading the extension configuration."),
                (11, "tool", "Read"),
                (12, "assistant", ""),
            ]
        );
        let durable = store
            .turn_rows(&TurnQuery {
                session: Some("fixture".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            durable[1].role, "assistant",
            "presentation leaves the ledger unchanged"
        );

        let screen = [
            "❯ okay now try",
            "",
            "Read 1 file, called bewpp 3 times, ran 1 shell command",
            "",
            "⏺ Blocked at the extension. Navigation requires site permission.",
            "",
            "⏺ Reading the extension configuration.",
        ]
        .map(str::to_owned);
        let turns = rows
            .into_iter()
            .map(|row| crate::boop::BoopTurn {
                session: row.session,
                harness: row.harness,
                turn: row.turn,
                ts: row.ts,
                role: row.role,
                said: row.said,
                session_scope: "root".into(),
                parent_session: None,
            })
            .collect();
        let strip = crate::squares::project_rows(
            "fixture",
            &screen,
            turns,
            Default::default(),
            Some(crate::boop_tmux::PaneWindow {
                height: screen.len(),
                scroll: 0,
            }),
            &boop_turnstrip::Options {
                mode: boop_turnstrip::Mode::Recent,
                ..Default::default()
            },
        );
        let layout = strip.layout.unwrap();
        assert_eq!(
            layout
                .squares()
                .iter()
                .map(|square| (square.id.as_str(), square.active))
                .collect::<Vec<_>>(),
            [
                ("fixture:1", true),
                ("fixture:9", true),
                ("fixture:10", true),
                ("fixture:12", false)
            ]
        );
        let tool = strip.turns.iter().find(|turn| turn.role == "tool").unwrap();
        assert_eq!((tool.turn, tool.anchor_start, tool.anchor_end), (8, 2, 2));
        let boop_turnstrip::Layout::Recent(recent) = layout else {
            panic!("recent mode");
        };
        assert_eq!(
            recent.gap,
            Some(boop_turnstrip::ToolGap {
                before_id: Some("fixture:1".into()),
                after_id: Some("fixture:9".into()),
                start_row: 2,
                end_row: 2,
            })
        );
    }
}
