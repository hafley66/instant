// The pane-to-session probe. All session discovery, shaping and message
// reading live in boop-harness; this file only resolves the pane and mailbox,
// then asks boop-harness which harness session stands in that pane.

use boop_harness::live;
use boop_harness::Registry;
use boop_store::ident::{Store, TurnQuery};
use boop_mux::{Multiplexer, Tmux};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoopMuxSession {
    session: String,
    harness: Option<String>,
}

fn stored_harness(session: &str) -> Option<String> {
    let store = Store::open_readonly(crate::boop::boop_db_path().ok()?).ok()?;
    store
        .turn_rows(&TurnQuery {
            session: Some(session.to_owned()),
            limit: Some(1),
            ..Default::default()
        })
        .ok()?
        .into_iter()
        .next()
        .map(|turn| turn.harness)
}

/// The harness session standing in a tmux pane, answered by each harness's own
/// live registry rather than by a transcript mtime or a tmux scrape.
#[tauri::command]
pub async fn boop_mux_session(
    target: String,
    socket: Option<String>,
) -> Result<Option<BoopMuxSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| {
            std::env::var("INSTANT_TMUX_SOCKET")
                .ok()
                .filter(|value| !value.is_empty())
        });
        let Some(pane) = live::pane_of_target(&target)
            .or_else(|| Tmux.pane_id(socket.as_deref(), &target))
        else {
            return Ok(None);
        };
        let mail_dir = match std::env::var_os("BOOP_MAIL_DIR").filter(|path| !path.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => boop_store::bus::default_mail_dir().map_err(|error| error.to_string())?,
        };
        let registry = Registry::discover();
        let live_harness = registry.all().iter().find_map(|adapter| {
            adapter
                .live()
                .live_session_in_pane_on_socket(&pane, socket.as_deref())
                .ok()?
                .map(|session| (session.session_id, adapter.id().as_str().to_owned()))
        });
        let Some(session) = live::session_in_pane_on_socket(
            &registry,
            &pane,
            socket.as_deref(),
            &mail_dir,
        )
        .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        let harness = live_harness
            .filter(|(live_session, _)| live_session == &session)
            .map(|(_, harness)| harness)
            .or_else(|| stored_harness(&session));
        Ok(Some(BoopMuxSession { session, harness }))
    })
    .await
    .map_err(|error| error.to_string())?
}
