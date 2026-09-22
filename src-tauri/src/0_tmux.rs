use boop_mux::{Multiplexer, Tmux};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn tmux_command(socket: Option<&str>) -> crate::proc::Proc {
    crate::proc::Proc::tmux_bare(socket, crate::proc::Label::TmuxControl)
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

/// Return a pane to its live screen before anything is typed at it.
///
/// A pane parked in copy-mode routes every keystroke to copy-mode, so a paste
/// lands in the scrollback viewer and never reaches the app's input bar. The
/// pane also stays wherever it was scrolled to. `cancel` leaves the mode and
/// snaps back to the live bottom; on a pane that is in no mode it does nothing,
/// so this is safe to run before every send.
#[tauri::command]
pub async fn boop_mux_exit_copy_mode(
    target: String,
    socket: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let socket = socket
            .or_else(|| std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty()));
        leave_copy_mode(socket.as_deref(), &target)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Where the pane's rows are: how many there are, and how far a client has
/// scrolled its copy-mode view up from the live bottom.
///
/// Scrolling a pane is a tmux copy-mode view (`pty::scroll_session`), never
/// xterm scrollback, and `capture-pane -S -n` returns the history above the
/// live area followed by the live area itself whatever the copy-mode offset is
/// (measured: a pane scrolled 20 rows still captures newest-first at the tail).
/// The client's window is therefore the capture's tail shifted up by
/// `scroll_position`, which is empty outside copy-mode and counts rows up from
/// the live bottom inside it.
pub(crate) struct PaneWindow {
    pub height: usize,
    pub scroll: usize,
}

/// One `display-message` for both numbers: a separate call per number would be
/// two tmux round trips inside a projection the pane can outrun.
pub(crate) fn pane_window(target: &str, socket: Option<&str>) -> Result<PaneWindow, String> {
    let out = tmux_command(socket)
        .args([
            "display-message",
            "-p",
            "-t",
            target,
            "#{pane_height}|#{scroll_position}",
        ])
        .run()
        .map_err(|error| error.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().split('|');
    let height = parts
        .next()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .ok_or_else(|| format!("pane_height {target}: {}", text.trim()))?;
    let scroll = parts
        .next()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    Ok(PaneWindow { height, scroll })
}

/// Whether the pane was in a mode and had to be brought back.
fn leave_copy_mode(socket: Option<&str>, pane: &str) -> Result<bool, String> {
    let out = tmux_command(socket)
        .args(["display-message", "-p", "-t", pane, "#{pane_in_mode}"])
        .run()
        .map_err(|error| error.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if String::from_utf8_lossy(&out.stdout).trim() != "1" {
        return Ok(false);
    }
    run(tmux_command(socket).args(["send-keys", "-X", "-t", pane, "cancel"]))?;
    Ok(true)
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
        // Every mode below types at the pane, and a pane in copy-mode consumes
        // keystrokes itself.
        leave_copy_mode(socket.as_deref(), &pane)?;
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
    let loaded = crate::proc::Proc::tmux_bare(socket, crate::proc::Label::TmuxPaste)
        .args(["load-buffer", "-b", &buffer, "-"])
        .feed(body.as_bytes())?;
    if !loaded.status.success() {
        return Err(String::from_utf8_lossy(&loaded.stderr).trim().to_string());
    }
    let pasted = run(tmux_command(socket).args([
        "paste-buffer",
        "-d",
        "-p",
        "-b",
        &buffer,
        "-t",
        pane,
    ]));
    if pasted.is_err() {
        let _ = tmux_command(socket).args(["delete-buffer", "-b", &buffer]).run();
    }
    pasted
}

fn run(command: crate::proc::Proc) -> Result<(), String> {
    Ok(command.ok()?)
}
