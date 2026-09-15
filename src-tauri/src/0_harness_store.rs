// The pane-to-session probe. All session discovery, shaping and message
// reading live in boop-harness; this file only resolves the pane and mailbox,
// then asks boop-harness which harness session stands in that pane.

use boop_harness::live;
use boop_harness::Registry;
use boop_mux::{Multiplexer, Tmux};
use std::path::PathBuf;

fn with_session_lookup_socket<T>(
    socket: Option<&str>,
    lookup: impl FnOnce(Option<&str>) -> T,
) -> T {
    lookup(socket)
}

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
        with_session_lookup_socket(socket.as_deref(), |socket| {
            live::session_in_pane_on_socket(&Registry::discover(), &pane, socket, &mail_dir)
                .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::with_session_lookup_socket;

    #[test]
    fn forwards_the_resolved_socket_to_the_live_session_lookup() {
        let received = with_session_lookup_socket(Some("instant-test.sock"), |socket| {
            socket.map(str::to_owned)
        });

        assert_eq!(received, Some("instant-test.sock".to_owned()));
    }
}
