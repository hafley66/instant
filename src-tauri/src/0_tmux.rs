use boop_mux::{Multiplexer, Tmux};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

fn tmux_args(socket: Option<&str>) -> Vec<String> {
    socket.map(|value| vec!["-L".into(), value.into()]).unwrap_or_default()
}

fn registry_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BOOP_MAIL_DIR").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path).join("registry.json"));
    }
    std::env::var_os("HOME").map(PathBuf::from)
        .map(|home| home.join(".agent/mail/registry.json"))
        .ok_or("HOME unavailable".to_string())
}

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

#[tauri::command]
pub async fn boop_mux_session(target: String, socket: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty()));
        let mut args = tmux_args(socket.as_deref());
        args.extend(["display-message".into(), "-p".into(), "-t".into(), target, "#{pane_id}".into()]);
        let output = Command::new("tmux").args(args).output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        let pane = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let registry: Value = serde_json::from_slice(
            &std::fs::read(registry_path()?).map_err(|error| error.to_string())?,
        ).map_err(|error| error.to_string())?;
        Ok(registry.as_object().and_then(|entries| entries.values().find_map(|entry| {
            (entry.get("tmux")?.as_str()? == pane).then(|| entry.get("sessionId")?.as_str().map(str::to_string)).flatten()
        })))
    }).await.map_err(|error| error.to_string())?
}

/// Sends a literal body plus Enter to a tmux pane. With no `target`, resolves the
/// client's currently visible pane, so the keystrokes land wherever the user is looking.
///
/// `mode` picks what actually happens:
///   "clear"  clear the input line with C-u, then paste and submit. Default.
///            Without the clear, whatever the user had half-typed gets submitted
///            in front of the body.
///   "paste"  paste and submit without clearing, the old behaviour.
///   "escape" send Escape only. Interrupts a Claude Code or Codex turn at once
///            and never touches the input buffer.
#[tauri::command]
pub async fn boop_mux_send_keys(
    body: String,
    target: Option<String>,
    socket: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty()));
        let pane = match target {
            Some(target) if !target.is_empty() => target,
            _ => Tmux.current_pane(socket.as_deref()).ok_or("no visible tmux pane")?,
        };
        let mode = mode.unwrap_or_else(|| "clear".to_string());
        if mode == "escape" {
            return Tmux
                .send_key_named(socket.as_deref(), &pane, "Escape")
                .map(|()| pane)
                .map_err(|error| error.to_string());
        }
        if mode == "clear" {
            // C-u kills the line in readline and in both TUI composers, so the
            // paste lands on an empty prompt rather than appended to a draft.
            Tmux.send_key_named(socket.as_deref(), &pane, "C-u")
                .map_err(|error| error.to_string())?;
        }
        Tmux.send_keys_literal(socket.as_deref(), &pane, &body)
            .map(|()| pane)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
