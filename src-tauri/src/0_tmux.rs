use boop_mux::{Multiplexer, Tmux};

#[tauri::command]
pub async fn boop_mux_capture(target: String, socket: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty()));
        Tmux.capture_pane(socket.as_deref(), &target, None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
