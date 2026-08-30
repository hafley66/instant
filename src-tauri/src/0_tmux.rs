use boop_mux::{Multiplexer, Tmux};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

fn tmux_command(socket: Option<&str>) -> Command {
    let mut command = Command::new("tmux");
    if let Some(socket) = socket {
        command.args(["-L", socket]);
    }
    command
}

#[tauri::command]
pub async fn boop_mux_capture(target: String, socket: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket.or_else(|| {
            std::env::var("INSTANT_TMUX_SOCKET")
                .ok()
                .filter(|value| !value.is_empty())
        });
        Tmux.capture_pane(socket.as_deref(), &target, None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
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
        let socket = socket.or_else(|| {
            std::env::var("INSTANT_TMUX_SOCKET")
                .ok()
                .filter(|value| !value.is_empty())
        });
        let pane = match target {
            Some(target) if !target.is_empty() => target,
            _ => Tmux
                .current_pane(socket.as_deref())
                .ok_or("no visible tmux pane")?,
        };
        let mode = mode.unwrap_or_else(|| "clear".to_string());
        if mode == "escape" {
            return send_key(socket.as_deref(), &pane, "Escape").map(|()| pane);
        }
        if mode == "clear" {
            // C-u kills the line in readline and in both TUI composers, so the
            // paste lands on an empty prompt rather than appended to a draft.
            send_key(socket.as_deref(), &pane, "C-u")?;
        }
        paste_body(socket.as_deref(), &pane, &body)?;
        std::thread::sleep(SUBMIT_GAP);
        send_key(socket.as_deref(), &pane, "Enter").map(|()| pane)
    })
    .await
    .map_err(|error| error.to_string())?
}

// boop-harness gap: keystroke delivery. `Multiplexer::{send_keys_literal,
// send_key_named}` were cut with `send_native`; instant still pastes at a pane.
const SUBMIT_GAP: std::time::Duration = std::time::Duration::from_millis(400);
static PASTE_SEQ: AtomicU64 = AtomicU64::new(0);

fn send_key(socket: Option<&str>, pane: &str, key: &str) -> Result<(), String> {
    run(tmux_command(socket).args(["send-keys", "-t", pane, key]))
}

/// A tmux buffer pasted in bracketed-paste mode, so a multi-line body reaches a
/// TUI composer as one paste rather than as a run of submits.
fn paste_body(socket: Option<&str>, pane: &str, body: &str) -> Result<(), String> {
    let buffer = format!(
        "instant-{}-{}",
        std::process::id(),
        PASTE_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let mut child = tmux_command(socket)
        .args(["load-buffer", "-b", &buffer, "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or("tmux load-buffer stdin")?
        .write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    let loaded = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !loaded.status.success() {
        return Err(String::from_utf8_lossy(&loaded.stderr).trim().to_string());
    }
    let pasted =
        run(tmux_command(socket).args(["paste-buffer", "-d", "-p", "-b", &buffer, "-t", pane]));
    if pasted.is_err() {
        let _ = tmux_command(socket)
            .args(["delete-buffer", "-b", &buffer])
            .output();
    }
    pasted
}

fn run(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}
