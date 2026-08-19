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
fn claude_messages_resolve_one_exact_file_without_session_discovery() {
    let home = fixture_home();
    let cwd = "/fixture";
    let project = claude_project_dir(&home, cwd);
    fs::create_dir_all(project.join("parent/subagents")).unwrap();
    fs::write(
        project.join("unrelated.jsonl"),
        "{ invalid and intentionally unreadable\n",
    )
    .unwrap();
    fs::write(
        project.join("wanted.jsonl"),
        r#"{"type":"user","uuid":"message-1","timestamp":"2026-07-20T10:00:10.000Z","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"direct"}}"#,
    )
    .unwrap();
    fs::write(
        project.join("parent/subagents/agent-1.jsonl"),
        r#"{"type":"user","uuid":"message-2","timestamp":"2026-07-20T10:00:11.000Z","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"subagent"}}"#,
    )
    .unwrap();

    let direct_path = claude_session_path(&home, cwd, "wanted").unwrap();
    let subagent_path = claude_session_path(&home, cwd, "agent-1").unwrap();
    let direct = crate::ledger::read_claude(&direct_path, "wanted", None);
    let subagent = crate::ledger::read_claude(&subagent_path, "agent-1", None);
    let receipt = json!({
        "direct": direct.iter().map(|message| (&message.id, &message.text)).collect::<Vec<_>>(),
        "subagent": subagent.iter().map(|message| (&message.id, &message.text)).collect::<Vec<_>>(),
        "missing": claude_session_path(&home, cwd, "absent"),
    });

    assert_eq!(
        serde_json::to_string_pretty(&receipt).unwrap(),
        r#"{
  "direct": [
    [
      "message-1",
      "direct"
    ]
  ],
  "missing": null,
  "subagent": [
    [
      "message-2",
      "subagent"
    ]
  ]
}"#
    );
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
            r#"{"type":"turn_context","payload":{"model":"gpt-fixture","model_provider":"openai"}}"#,
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
         INSERT INTO message VALUES ('opencode-1', 200, '{\"tokens\":{\"input\":13},\"providerID\":\"openrouter\"}');",
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
            "provider": session.provider,
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
    "provider": "anthropic",
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
    "provider": "openrouter",
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
    "provider": "openai",
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
    "provider": null,
    "sourceFile": "wire.jsonl",
    "title": null
  }
]"#
    );
}

#[test]
fn opencode_tokens_take_max_not_latest() {
    // The newest assistant turn carries tokens.input 0; MAX across the session
    // is the live context reading, not the trailing zero.
    let home = fixture_home();
    let cwd = "/fixture";
    let dir = home.join(".local/share/opencode");
    fs::create_dir_all(&dir).unwrap();
    let db = Connection::open(dir.join("opencode.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
         CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('oc-1', '/fixture', NULL, 100, 300, NULL);
         INSERT INTO message VALUES ('oc-1', 100, '{\"tokens\":{\"input\":50},\"modelID\":\"a-model\",\"providerID\":\"provider-a\"}');
         INSERT INTO message VALUES ('oc-1', 200, '{\"tokens\":{\"input\":0}}');",
    )
    .unwrap();
    drop(db);
    let session = resolve(&home, HarnessId::Opencode, cwd).unwrap();
    assert_eq!(session.id, "oc-1");
    assert_eq!(session.input_tokens, Some(50));
    assert_eq!(session.model.as_deref(), Some("a-model"));
    assert_eq!(session.provider.as_deref(), Some("provider-a"));
}

#[test]
fn claude_session_ids_use_metadata_without_parsing_transcripts() {
    let home = fixture_home();
    let cwd = "/fixture";
    let dir = home.join(".claude/projects/-fixture");
    fs::create_dir_all(dir.join("parent/subagents")).unwrap();
    fs::write(
        dir.join("broken.jsonl"),
        "{ this transcript is intentionally invalid",
    )
    .unwrap();
    fs::write(
        dir.join("parent/subagents/child.jsonl"),
        "{ this transcript is intentionally invalid",
    )
    .unwrap();

    let mut ids = session_ids(&home, HarnessId::Claude, cwd);
    ids.sort();

    assert_eq!(ids, vec!["broken", "child"]);
}

#[test]
fn codex_session_ids_use_the_index_without_parsing_rollouts() {
    let home = fixture_home();
    let dir = home.join(".codex");
    fs::create_dir_all(&dir).unwrap();
    let db = Connection::open(dir.join("state_5.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER, updated_at_ms INTEGER);
         INSERT INTO threads VALUES ('older', '/fixture', 0, 100);
         INSERT INTO threads VALUES ('newer', '/fixture', 0, 200);
         INSERT INTO threads VALUES ('archived', '/fixture', 1, 300);
         INSERT INTO threads VALUES ('elsewhere', '/other', 0, 400);",
    )
    .unwrap();
    drop(db);

    assert_eq!(
        session_ids(&home, HarnessId::Codex, "/fixture"),
        vec!["newer", "older"]
    );
}

#[test]
fn kimi_session_ids_do_not_parse_wire_history() {
    let home = fixture_home();
    let dir = home.join(".kimi-code/sessions/work/session_kimi-fast");
    fs::create_dir_all(dir.join("agents/main")).unwrap();
    fs::write(dir.join("state.json"), r#"{"workDir":"/fixture"}"#).unwrap();
    fs::write(
        dir.join("agents/main/wire.jsonl"),
        "not JSON and deliberately irrelevant",
    )
    .unwrap();

    assert_eq!(
        session_ids(&home, HarnessId::Kimi, "/fixture"),
        vec!["kimi-fast"]
    );
}

#[test]
fn kimi_wire_usage_sums_inputs() {
    // wire.jsonl carries per-turn usage; input = inputOther + cache read + cache
    // creation, taken from the last line that has it, with the model beside it.
    let home = fixture_home();
    let cwd = "/fixture";
    let dir = home.join(".kimi-code/sessions/work/session_kimi-2");
    fs::create_dir_all(dir.join("agents/main")).unwrap();
    fs::write(dir.join("state.json"), r#"{"workDir":"/fixture"}"#).unwrap();
    fs::write(
        dir.join("agents/main/wire.jsonl"),
        concat!(
            r#"{"type":"assistant","model":"kimi-code/k3","usage":{"inputOther":10,"output":1,"inputCacheRead":100,"inputCacheCreation":5},"usageScope":"turn"}"#,
            "\n",
            r#"{"type":"assistant","model":"kimi-code/k3","usage":{"inputOther":15,"output":2,"inputCacheRead":200,"inputCacheCreation":0},"usageScope":"turn"}"#,
            "\n",
        ),
    )
    .unwrap();
    let session = resolve(&home, HarnessId::Kimi, cwd).unwrap();
    assert_eq!(session.id, "kimi-2");
    assert_eq!(session.input_tokens, Some(215));
    assert_eq!(session.model.as_deref(), Some("kimi-code/k3"));
}
