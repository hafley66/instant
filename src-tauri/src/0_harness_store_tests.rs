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

/// A session boop-harness would hand instant, minted here so shaping is tested
/// without a fixture HOME the registry cannot be pointed at.
fn session_ref(harness: HarnessId, id: &str, path: PathBuf) -> SessionRef {
    SessionRef {
        harness,
        session_id: id.to_string(),
        nickname: id.to_string(),
        cwd: Some("/fixture".to_string()),
        git_branch: None,
        modified_ms: mtime(&path),
        size: 0,
        tmux: None,
        tmux_socket: None,
        parent: None,
        path,
    }
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
        "missing": claude_session_path(&home, cwd, "absent"),
        "subagent": subagent.iter().map(|message| (&message.id, &message.text)).collect::<Vec<_>>(),
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
fn four_harnesses_lower_into_one_session_shape() {
    let home = fixture_home();

    let claude = home.join("claude-1.jsonl");
    fs::write(
        &claude,
        concat!(
            r#"{"cwd":"/fixture","timestamp":"2026-01-02T03:04:05Z"}"#,
            "\n",
            r#"{"message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}"#,
            "\n"
        ),
    )
    .unwrap();

    let codex = home.join("rollout.jsonl");
    fs::write(
        &codex,
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

    let kimi_session = home.join("kimi/session_kimi-1");
    fs::create_dir_all(kimi_session.join("agents/main")).unwrap();
    fs::write(kimi_session.join("state.json"), r#"{"workDir":"/fixture"}"#).unwrap();
    let kimi = kimi_session.join("agents/main/wire.jsonl");
    fs::write(&kimi, "").unwrap();

    let opencode = home.join("opencode.db");
    let db = Connection::open(&opencode).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
         CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('opencode-1', '/fixture', 'OpenCode fixture', 100, 200, NULL);
         INSERT INTO message VALUES ('opencode-1', 200, '{\"tokens\":{\"input\":13},\"providerID\":\"openrouter\"}');",
    )
    .unwrap();
    drop(db);

    let mut codex_ref = session_ref(HarnessId::Codex, "codex-1", codex);
    codex_ref.parent = Some("codex-parent".to_string());
    let summary: Vec<Value> = [
        session_ref(HarnessId::Claude, "claude-1", claude),
        session_ref(HarnessId::Opencode, "opencode-1", opencode),
        codex_ref,
        session_ref(HarnessId::Kimi, "kimi-1", kimi),
    ]
    .iter()
    .map(|session| shape(session).unwrap())
    .map(|session| {
        json!({
            "cwd": session.cwd,
            "harness": session.harness,
            "id": session.id,
            "inputTokens": session.input_tokens,
            "model": session.model,
            "parentId": session.parent_id,
            "parentKind": session.parent_kind,
            "provider": session.provider,
            "sourceFile": session.source_path.as_deref().and_then(|path| Path::new(path).file_name()).and_then(|name| name.to_str()),
            "title": session.title,
        })
    })
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
    let path = home.join("opencode.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
         CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('oc-1', '/fixture', NULL, 100, 300, NULL);
         INSERT INTO message VALUES ('oc-1', 100, '{\"tokens\":{\"input\":50},\"modelID\":\"a-model\",\"providerID\":\"provider-a\"}');
         INSERT INTO message VALUES ('oc-1', 200, '{\"tokens\":{\"input\":0}}');",
    )
    .unwrap();
    drop(db);
    let session = shape(&session_ref(HarnessId::Opencode, "oc-1", path)).unwrap();
    assert_eq!(session.id, "oc-1");
    assert_eq!(session.input_tokens, Some(50));
    assert_eq!(session.model.as_deref(), Some("a-model"));
    assert_eq!(session.provider.as_deref(), Some("provider-a"));
}

#[test]
fn an_archived_opencode_session_is_not_a_row() {
    let home = fixture_home();
    let path = home.join("opencode.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
         CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('oc-gone', '/fixture', NULL, 100, 300, 400);",
    )
    .unwrap();
    drop(db);
    assert!(shape(&session_ref(HarnessId::Opencode, "oc-gone", path)).is_none());
}

#[test]
fn kimi_wire_usage_sums_inputs() {
    // wire.jsonl carries per-turn usage; input = inputOther + cache read + cache
    // creation, taken from the last line that has it, with the model beside it.
    let home = fixture_home();
    let dir = home.join("session_kimi-2");
    fs::create_dir_all(dir.join("agents/main")).unwrap();
    fs::write(dir.join("state.json"), r#"{"workDir":"/fixture"}"#).unwrap();
    let wire = dir.join("agents/main/wire.jsonl");
    fs::write(
        &wire,
        concat!(
            r#"{"type":"assistant","model":"kimi-code/k3","usage":{"inputOther":10,"output":1,"inputCacheRead":100,"inputCacheCreation":5},"usageScope":"turn"}"#,
            "\n",
            r#"{"type":"assistant","model":"kimi-code/k3","usage":{"inputOther":15,"output":2,"inputCacheRead":200,"inputCacheCreation":0},"usageScope":"turn"}"#,
            "\n",
        ),
    )
    .unwrap();
    let session = shape(&session_ref(HarnessId::Kimi, "kimi-2", wire)).unwrap();
    assert_eq!(session.id, "kimi-2");
    assert_eq!(session.input_tokens, Some(215));
    assert_eq!(session.model.as_deref(), Some("kimi-code/k3"));
}

/// RECEIPT. A claude subagent transcript resumes on its file stem, while every
/// other harness resumes on the id it published, so `--resume` gets the id the
/// harness answers to.
#[test]
fn a_resume_id_is_the_stem_for_claude_and_the_session_id_elsewhere() {
    let mut claude = session_ref(HarnessId::Claude, "parent/agent-9", PathBuf::new());
    claude.nickname = "agent-9".to_string();
    claude.parent = Some("parent".to_string());
    assert_eq!(resume_id(&claude), "agent-9");

    let mut codex = session_ref(HarnessId::Codex, "thread-9", PathBuf::new());
    codex.nickname = "rollout-2026".to_string();
    assert_eq!(resume_id(&codex), "thread-9");
}
