use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn fixture_home() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "instant_harness_store_{}_{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn four_stores_lower_into_one_session_shape() {
    let home = fixture_home();
    let cwd = "/fixture";

    let claude_dir = home.join(".claude/projects/-fixture");
    fs::create_dir_all(&claude_dir).unwrap();
    fs::write(
        claude_dir.join("claude-1.jsonl"),
        concat!(
            r#"{"cwd":"/fixture","timestamp":"2026-01-02T03:04:05Z"}"#,
            "\n",
            r#"{"message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}"#,
            "\n"
        ),
    )
    .unwrap();

    let codex_dir = home.join(".codex/sessions/2026/01/02");
    fs::create_dir_all(&codex_dir).unwrap();
    fs::write(
        codex_dir.join("rollout.jsonl"),
        concat!(
            r#"{"timestamp":"2026-01-02T03:04:05Z","type":"session_meta","payload":{"id":"codex-1","cwd":"/fixture","parent_thread_id":"codex-parent"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"gpt-fixture"}}"#,
            "\n",
            r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":21}}}}"#,
            "\n"
        ),
    )
    .unwrap();

    let kimi_dir = home.join(".kimi-code/sessions/work/session_kimi-1");
    fs::create_dir_all(kimi_dir.join("agents/main")).unwrap();
    fs::write(kimi_dir.join("state.json"), r#"{"workDir":"/fixture"}"#).unwrap();
    fs::write(kimi_dir.join("agents/main/wire.jsonl"), "").unwrap();

    let opencode_dir = home.join(".local/share/opencode");
    fs::create_dir_all(&opencode_dir).unwrap();
    let db = Connection::open(opencode_dir.join("opencode.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
         CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('opencode-1', '/fixture', 'OpenCode fixture', 100, 200, NULL);
         INSERT INTO message VALUES ('opencode-1', 200, '{\"tokens\":{\"input\":13}}');",
    )
    .unwrap();
    drop(db);

    let summary: Vec<Value> = [HarnessId::Claude, HarnessId::Opencode, HarnessId::Codex, HarnessId::Kimi]
        .into_iter()
        .map(|id| resolve(&home, id, cwd).unwrap())
        .map(|session| json!({
            "harness": session.harness,
            "id": session.id,
            "cwd": session.cwd,
            "sourceFile": session.source_path.as_deref().and_then(|path| Path::new(path).file_name()).and_then(|name| name.to_str()),
            "title": session.title,
            "model": session.model,
            "inputTokens": session.input_tokens,
            "parentId": session.parent_id,
            "parentKind": session.parent_kind,
        }))
        .collect();

    assert_eq!(
        serde_json::to_string_pretty(&summary).unwrap(),
        r#"[
  {
    "cwd": "/fixture",
    "harness": "claude",
    "id": "claude-1",
    "inputTokens": 10,
    "model": null,
    "parentId": null,
    "parentKind": null,
    "sourceFile": "claude-1.jsonl",
    "title": null
  },
  {
    "cwd": "/fixture",
    "harness": "opencode",
    "id": "opencode-1",
    "inputTokens": 13,
    "model": null,
    "parentId": null,
    "parentKind": null,
    "sourceFile": null,
    "title": "OpenCode fixture"
  },
  {
    "cwd": "/fixture",
    "harness": "codex",
    "id": "codex-1",
    "inputTokens": 21,
    "model": "gpt-fixture",
    "parentId": "codex-parent",
    "parentKind": "subagent",
    "sourceFile": "rollout.jsonl",
    "title": null
  },
  {
    "cwd": "/fixture",
    "harness": "kimi",
    "id": "kimi-1",
    "inputTokens": null,
    "model": null,
    "parentId": null,
    "parentKind": null,
    "sourceFile": "wire.jsonl",
    "title": null
  }
]"#
    );
}
