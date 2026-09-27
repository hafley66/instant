use boop_mux::{Multiplexer, Tmux};

pub(crate) fn tmux_command(socket: Option<&str>) -> crate::proc::Proc {
    crate::proc::Proc::tmux_bare(socket, crate::proc::Label::TmuxControl)
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
        let socket = socket.or_else(|| {
            std::env::var("INSTANT_TMUX_SOCKET")
                .ok()
                .filter(|value| !value.is_empty())
        });
        leave_copy_mode(socket.as_deref(), &target)
    })
    .await
    .map_err(|error| error.to_string())?
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
        // Every mode below types at the pane, and a pane in copy-mode consumes
        // keystrokes itself.
        leave_copy_mode(socket.as_deref(), &pane)?;
        if mode == "escape" {
            Tmux.send_key_named(socket.as_deref(), &pane, "Escape")
                .map_err(|error| error.to_string())?;
            return Ok(pane);
        }
        if mode == "clear" {
            // C-u kills the line in readline and in both TUI composers, so the
            // paste lands on an empty prompt rather than appended to a draft.
            Tmux.send_key_named(socket.as_deref(), &pane, "C-u")
                .map_err(|error| error.to_string())?;
        }
        Tmux.send_text(socket.as_deref(), &pane, &body)
            .map_err(|error| error.to_string())?;
        std::thread::sleep(SUBMIT_GAP);
        Tmux.send_key_named(socket.as_deref(), &pane, "Enter")
            .map_err(|error| error.to_string())?;
        Ok(pane)
    })
    .await
    .map_err(|error| error.to_string())?
}

// Give the TUI a short window to consume the paste before submitting it.
const SUBMIT_GAP: std::time::Duration = std::time::Duration::from_millis(400);

fn run(command: crate::proc::Proc) -> Result<(), String> {
    Ok(command.ok()?)
}
