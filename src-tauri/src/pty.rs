// PTY layer: each tmux session gets its own pty running `tmux new-session -A -s <name>`.
// -A means "attach if it exists, else create", so summon is instant and the
// claude/opencode process inside survives detach.
//
// Storage: PtyStore holds id -> live writer + master, behind a Mutex.
// Reads happen on a per-pty thread that emits `pty-data` events to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

// GUI apps don't inherit the login shell PATH, so tmux/claude/opencode won't be
// found without this. Prepend the usual homebrew + system locations.
const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

fn path_env() -> String {
    match std::env::var("PATH") {
        Ok(p) => format!("{EXTRA_PATH}:{p}"),
        Err(_) => EXTRA_PATH.to_string(),
    }
}

struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct PtyStore(Mutex<HashMap<String, PtyHandle>>);

#[derive(Serialize, Clone)]
pub struct Session {
    name: String,
    windows: u32,
    attached: bool,
}

/// Emitted to the webview as `pty-data`.
#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    chunk: String,
}

#[tauri::command]
pub fn list_sessions() -> Vec<Session> {
    let out = std::process::Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_windows}\t#{session_attached}",
        ])
        .env("PATH", path_env())
        .output();

    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            let name = it.next()?.to_string();
            let windows = it.next()?.parse().unwrap_or(1);
            let attached = it.next()? != "0";
            Some(Session { name, windows, attached })
        })
        .collect()
}

/// Open (or reattach to) a tmux session in a fresh pty bound to webview id `id`.
#[tauri::command]
pub fn open_session(
    app: AppHandle,
    store: State<PtyStore>,
    id: String,
    name: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    {
        // Already wired up for this tab; just resize and bail.
        let map = store.0.lock().unwrap();
        if map.contains_key(&id) {
            drop(map);
            return resize_pty(store, id, cols, rows);
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // `-A` attaches if the session exists, else creates it. When creating, the
    // trailing command runs inside; on reattach tmux ignores it. So a quick-start
    // session "claude" launches `claude` the first time and just reattaches after.
    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["new-session", "-A", "-s", &name]);
    if let Some(run) = command.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg(run);
    }
    cmd.env("PATH", path_env());
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    store
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), PtyHandle { writer, master: pair.master });

    // Reader thread: pump pty -> webview until EOF (session detached/killed).
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("pty-data", PtyData { id: id.clone(), chunk });
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(store: State<PtyStore>, id: String, data: String) -> Result<(), String> {
    let mut map = store.0.lock().unwrap();
    if let Some(h) = map.get_mut(&id) {
        h.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        h.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(store: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = store.0.lock().unwrap();
    if let Some(h) = map.get(&id) {
        h.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop the pty for a tab. The tmux session (and claude/opencode inside) keeps running.
#[tauri::command]
pub fn close_pty(store: State<PtyStore>, id: String) {
    store.0.lock().unwrap().remove(&id);
}
