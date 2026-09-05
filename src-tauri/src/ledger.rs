// Thin tauri commands over boop-harness. All transcript reading and session
// shaping live in boop-harness; this file maps a harness tag + cwd to the wire
// rows the UI reads back.

use boop_harness::transcript::Message;
use boop_harness::{HarnessId, Registry};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AiSession {
    pub editor: HarnessId,
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub updated: u64,         // unix ms of the newest message
    pub path: Option<String>, // jsonl path (claude); None for opencode (db row)
}

/// All turns in one session, oldest first. `after_seq` returns only newer turns
/// (the watcher's incremental read).
#[tauri::command]
pub async fn read_ai_messages(
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
) -> Result<Vec<Message>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_ai_messages_blocking(editor, session_id, cwd, after_seq)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_ai_messages_blocking(
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
) -> Result<Vec<Message>, String> {
    let id = HarnessId::parse(&editor).ok_or("unknown editor")?;
    Ok(Registry::discover().messages_by_id(id, &session_id, &cwd, after_seq))
}

/// The newest turn in a session (drives "favorite current turn" + the watcher).
#[tauri::command]
pub async fn latest_ai_message(
    editor: String,
    session_id: String,
    cwd: String,
) -> Result<Option<Message>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut msgs = read_ai_messages_blocking(editor, session_id, cwd, None)?;
        Ok(msgs.pop())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sessions for a cwd (or all, when cwd is None), newest first. Lightweight
/// browse list; reading the turns is a separate call.
#[tauri::command]
pub async fn list_ai_sessions(
    editor: String,
    cwd: Option<String>,
) -> Result<Vec<AiSession>, String> {
    tauri::async_runtime::spawn_blocking(move || list_ai_sessions_blocking(editor, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn list_ai_sessions_blocking(
    editor: String,
    cwd: Option<String>,
) -> Result<Vec<AiSession>, String> {
    let harness = HarnessId::parse(&editor).ok_or("unknown editor")?;
    let registry = Registry::discover();
    Ok(registry
        .describe_all(harness, cwd.as_deref())
        .into_iter()
        .map(|session| {
            let title = session.title.clone().unwrap_or_else(|| {
                registry
                    .messages_by_id(harness, &session.id, &session.cwd, None)
                    .into_iter()
                    .find(|message| message.role == "user")
                    .map(|message| message.preview)
                    .unwrap_or_default()
            });
            AiSession {
                editor: harness,
                id: session.id,
                cwd: session.cwd,
                title,
                updated: session.last_activity_ms,
                path: session.source_path,
            }
        })
        .collect(),
    )
}

// Re-export the editor tag for the favorites module's identity strings.
pub fn editor_tag(id: HarnessId) -> &'static str {
    id.as_str()
}
