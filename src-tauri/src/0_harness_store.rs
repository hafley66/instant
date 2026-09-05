// The pane-to-session probe. All session discovery, shaping and message
// reading live in boop-harness; this file only resolves the pane and mailbox,
// then asks boop-harness which harness session stands in that pane.

use boop_harness::live;
use boop_harness::Registry;
use boop_mux::{Multiplexer, Tmux};
use std::path::PathBuf;

/// The harness session standing in a tmux pane, answered by each harness's own
/// live registry rather than by a transcript mtime or a tmux scrape.
#[tauri::command]
pub async fn boop_mux_session(
    target: String,
    socket: Option<String>,
) -> Result<Option<String>, String> {
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
        live::session_in_pane(&Registry::discover(), &pane, &mail_dir)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
