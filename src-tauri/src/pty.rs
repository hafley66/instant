// PTY layer: each tmux session gets its own pty running `tmux new-session -A -s <name>`.
// -A means "attach if it exists, else create", so summon is instant and the
// claude/opencode process inside survives detach.
//
// Storage: PtyStore holds id -> live writer + master, behind a Mutex.
// Reads happen on a per-pty thread that emits `pty-data` events to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::kitty::{KittyScanner, ScanOut};

// GUI apps don't inherit the login shell PATH, so tmux/claude/opencode won't be
// found without this. Prepend the usual homebrew + system locations.
const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

pub(crate) fn path_env() -> String {
    match std::env::var("PATH") {
        Ok(p) => format!("{EXTRA_PATH}:{p}"),
        Err(_) => EXTRA_PATH.to_string(),
    }
}

/// Writer is shared so the per-pty reader thread can also write back to the pty
/// (kitty graphics query acknowledgements) without taking the store lock.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct PtyHandle {
    writer: SharedWriter,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct PtyStore(Mutex<HashMap<String, PtyHandle>>);

#[derive(Serialize, Clone)]
pub struct Session {
    name: String,
    windows: u32,
    attached: bool,
    /// Unix seconds of the session's last activity / creation. The frontend
    /// sorts the launcher by these (most-recent first by default).
    activity: i64,
    created: i64,
    /// Distinct current working directories across this session's panes. The
    /// frontend maps these to worktrees (longest-prefix match) to relate a
    /// session to the worktrees it has touched.
    paths: Vec<String>,
    /// Distinct foreground process names across this session's panes
    /// (#{pane_current_command}): claude, opencode, nvim, zsh… The frontend
    /// shows these so you can see what bot/tool a session is actually running.
    commands: Vec<String>,
}

/// Emitted to the webview as `pty-data`.
#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    chunk: String,
}

/// Emitted to the webview as `pty-graphics` (one resolved kitty frame). v1 ships
/// RGBA as base64 over the JSON event; switch to a binary Channel if 60fps
/// throughput needs it (see plan task D).
#[derive(Serialize, Clone)]
struct GraphicsEvent {
    id: String,
    action: char,
    img_id: u32,
    format: u16,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    no_scroll: bool,
    delete: bool,
    rgba_b64: String,
}

/// pixel_width/height for PtySize from cell metrics the frontend measured from
/// xterm. tmux ignores these; kitty-graphics apps (awrit) read them via
/// TIOCGWINSZ ws_xpixel/ws_ypixel to size their framebuffer.
fn pixel_dims(cols: u16, rows: u16, cell_w: Option<u16>, cell_h: Option<u16>) -> (u16, u16) {
    (
        cell_w.unwrap_or(0).saturating_mul(cols),
        cell_h.unwrap_or(0).saturating_mul(rows),
    )
}

#[tauri::command]
pub fn list_sessions() -> Vec<Session> {
    let out = std::process::Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_created}",
        ])
        .env("PATH", path_env())
        .output();

    let (mut paths, mut commands) = session_pane_info();
    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            let name = it.next()?.to_string();
            let windows = it.next()?.parse().unwrap_or(1);
            let attached = it.next()? != "0";
            // tmux activity/created are ms-since-epoch on newer builds, seconds
            // on older; both fit i64 and the frontend only orders by them.
            let activity = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let created = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let paths = paths.remove(&name).unwrap_or_default();
            let commands = commands.remove(&name).unwrap_or_default();
            Some(Session { name, windows, attached, activity, created, paths, commands })
        })
        .collect()
}

/// session_name -> (distinct pane cwds, distinct foreground commands), from one
/// `tmux list-panes -a` call. Empty on any failure (the session list still
/// renders, just without worktree links or process labels).
fn session_pane_info() -> (HashMap<String, Vec<String>>, HashMap<String, Vec<String>>) {
    let out = std::process::Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_current_path}\t#{pane_current_command}",
        ])
        .env("PATH", path_env())
        .output();
    let mut paths: HashMap<String, Vec<String>> = HashMap::new();
    let mut commands: HashMap<String, Vec<String>> = HashMap::new();
    let Ok(out) = out else { return (paths, commands) };
    let push = |map: &mut HashMap<String, Vec<String>>, name: &str, val: &str| {
        if val.is_empty() {
            return;
        }
        let v = map.entry(name.to_string()).or_default();
        if !v.iter().any(|p| p == val) {
            v.push(val.to_string());
        }
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split('\t');
        let Some(name) = it.next() else { continue };
        if let Some(path) = it.next() {
            push(&mut paths, name, path);
        }
        if let Some(cmd) = it.next() {
            push(&mut commands, name, cmd);
        }
    }
    (paths, commands)
}

/// Turn on mouse mode for a session so the wheel scrolls the pane / forwards to
/// mouse-aware TUIs (claude, opencode). Per-session (not `-g`) to leave the
/// user's other tmux sessions alone. Retries: a freshly-created session may not
/// exist yet the instant new-session is spawned.
fn enable_mouse(name: &str) {
    let name = name.to_string();
    std::thread::spawn(move || {
        for _ in 0..15 {
            let ok = std::process::Command::new("tmux")
                .args(["set-option", "-t", &name, "mouse", "on"])
                .env("PATH", path_env())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        // With mouse on, a drag selects in tmux copy-mode and copies into tmux's
        // OWN buffer — never the macOS clipboard — so ⌘C finds nothing ("can't
        // copy after leaving opencode"). `set-clipboard on` makes tmux emit an
        // OSC 52 with the selection to the outer terminal (our xterm), which
        // bridges it to navigator.clipboard. `external` (the common default) only
        // forwards apps' own OSC 52, not tmux's mouse copy, so bump to `on`.
        // Server-wide (one tmux clipboard policy); harmless for other sessions.
        let _ = std::process::Command::new("tmux")
            .args(["set-option", "-g", "set-clipboard", "on"])
            .env("PATH", path_env())
            .status();
    });
}

/// Open (or reattach to) a session in a fresh pty bound to webview id `id`.
///
/// `graphics=true` spawns the command directly (no tmux, which filters kitty APC
/// graphics), sets TERM=xterm-kitty, and runs the pty reader through the kitty
/// graphics proxy. `cell_w`/`cell_h` are device pixels per terminal cell so the
/// pty reports a real pixel size to graphics apps.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn open_session(
    app: AppHandle,
    store: State<PtyStore>,
    id: String,
    name: String,
    command: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    graphics: Option<bool>,
    cell_w: Option<u16>,
    cell_h: Option<u16>,
) -> Result<(), String> {
    let graphics = graphics.unwrap_or(false);
    {
        // Already wired up for this tab; just resize and bail.
        let map = store.0.lock().unwrap();
        if map.contains_key(&id) {
            drop(map);
            if !graphics {
                enable_mouse(&name);
            }
            return resize_pty(store, id, cols, rows, cell_w, cell_h);
        }
    }

    let (pixel_width, pixel_height) = pixel_dims(cols, rows, cell_w, cell_h);
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width, pixel_height })
        .map_err(|e| e.to_string())?;

    let start_dir = cwd.as_deref().filter(|s| !s.is_empty());
    let cmd = if graphics {
        // Direct spawn via the login shell so the command (e.g. "awrit <url>")
        // gets PATH and arg parsing, then the session ends when it exits.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = CommandBuilder::new(&shell);
        match command.as_deref().filter(|s| !s.is_empty()) {
            Some(run) => c.args(["-lc", run]),
            None => c.arg("-l"),
        }
        c.env("PATH", path_env());
        c.env("TERM", "xterm-kitty");
        c
    } else {
        // When creating, the trailing command runs inside; on reattach tmux
        // ignores it. So a quick-start session "claude" launches `claude` the
        // first time and just reattaches after.
        // `-A` attaches if it exists else creates; `-D` detaches any OTHER client
        // on attach. Without -D, a leaked client from a prior webview reload
        // stays attached at its old 80x24 size and, under `window-size latest`,
        // strands a ghost status line. -D guarantees one client, so one size.
        let mut c = CommandBuilder::new("tmux");
        c.args(["new-session", "-A", "-D", "-s", &name]);
        // Start dir for a freshly-created session (a worktree path, usually).
        // tmux ignores -c when reattaching, like the trailing command.
        if let Some(dir) = start_dir {
            c.args(["-c", dir]);
        }
        if let Some(run) = command.as_deref().filter(|s| !s.is_empty()) {
            c.arg(run);
        }
        c.env("PATH", path_env());
        c.env("TERM", "xterm-256color");
        c
    };
    let mut cmd = cmd;
    match start_dir {
        Some(dir) => cmd.cwd(dir),
        None => {
            if let Some(home) = std::env::var_os("HOME") {
                cmd.cwd(home);
            }
        }
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    store
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), PtyHandle { writer: writer.clone(), master: pair.master });

    if !graphics {
        enable_mouse(&name); // wheel scrolls the pane / forwards to mouse-aware TUIs
    }

    // Reader thread: pump pty -> webview until EOF (session detached/killed).
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        if !graphics {
            // Fast path: plain terminal, no graphics parsing.
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit("pty-data", PtyData { id: id.clone(), chunk });
                    }
                }
            }
            return;
        }
        // Graphics path: split kitty APC frames out of the byte stream.
        let mut scanner = KittyScanner::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for out in scanner.feed(&buf[..n]) {
                        match out {
                            ScanOut::Passthrough(bytes) => {
                                let chunk = String::from_utf8_lossy(&bytes).to_string();
                                let _ = app.emit("pty-data", PtyData { id: id.clone(), chunk });
                            }
                            ScanOut::Graphics(g) => {
                                let _ = app.emit(
                                    "pty-graphics",
                                    GraphicsEvent {
                                        id: id.clone(),
                                        action: g.action,
                                        img_id: g.id,
                                        format: g.format,
                                        width: g.width,
                                        height: g.height,
                                        x: g.x,
                                        y: g.y,
                                        no_scroll: g.no_scroll,
                                        delete: g.delete,
                                        rgba_b64: STANDARD.encode(&g.rgba),
                                    },
                                );
                            }
                            ScanOut::Reply(bytes) => {
                                if let Ok(mut w) = writer.lock() {
                                    let _ = w.write_all(&bytes);
                                    let _ = w.flush();
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(store: State<PtyStore>, id: String, data: String) -> Result<(), String> {
    let map = store.0.lock().unwrap();
    if let Some(h) = map.get(&id) {
        let mut w = h.writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    store: State<PtyStore>,
    id: String,
    cols: u16,
    rows: u16,
    cell_w: Option<u16>,
    cell_h: Option<u16>,
) -> Result<(), String> {
    let (pixel_width, pixel_height) = pixel_dims(cols, rows, cell_w, cell_h);
    let map = store.0.lock().unwrap();
    if let Some(h) = map.get(&id) {
        h.master
            .resize(PtySize { rows, cols, pixel_width, pixel_height })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop the pty for a tab. The tmux session (and claude/opencode inside) keeps running.
#[tauri::command]
pub fn close_pty(store: State<PtyStore>, id: String) {
    store.0.lock().unwrap().remove(&id);
}

/// Scroll a session's tmux history, independent of whatever app is running. A
/// plain wheel only scrolls when the foreground app hasn't grabbed the mouse
/// (claude/opencode do), so this forces tmux copy-mode and scrolls there. `-e`
/// makes copy-mode auto-exit when scrolled back to the bottom (live view).
#[tauri::command]
pub fn scroll_session(name: String, up: bool, lines: u32) {
    let n = lines.max(1).to_string();
    let dir = if up { "scroll-up" } else { "scroll-down" };
    let path = path_env();
    // Enter copy-mode (no-op if already in it), then scroll N lines.
    let _ = std::process::Command::new("tmux")
        .args(["copy-mode", "-e", "-t", &name])
        .env("PATH", &path)
        .status();
    let _ = std::process::Command::new("tmux")
        .args(["send-keys", "-t", &name, "-X", "-N", &n, dir])
        .env("PATH", &path)
        .status();
}

/// Kill a tmux session outright (ends the shell/agent inside) and drop its pty.
#[tauri::command]
pub fn kill_session(store: State<PtyStore>, name: String) -> Result<(), String> {
    std::process::Command::new("tmux")
        .args(["kill-session", "-t", &name])
        .env("PATH", path_env())
        .status()
        .map_err(|e| e.to_string())?;
    store.0.lock().unwrap().remove(&format!("s:{name}"));
    Ok(())
}
