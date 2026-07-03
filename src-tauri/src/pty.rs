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
    /// Some only for direct-spawn graphics sessions (awrit). tmux sessions leave
    /// this None: closing their pty detaches the client, the server lives on. A
    /// direct child (awrit) catches SIGHUP, so dropping the master won't kill it
    /// — we must kill it explicitly on close or it orphans and holds its
    /// single-instance profile lock.
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
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

/// A `tmux` command. A prod build talks to a private tmux server (`-L
/// instant-prod`) so it can't see or clobber the sessions a `tauri dev` instance
/// (or the user's own terminal) drives on the default socket. Dev keeps the
/// default socket, so the running dev instance is unchanged. Every tmux call in
/// this file goes through here, including the new-session in the pty itself, so
/// the isolation is total. Discriminated by cfg!(debug_assertions).
fn tmux_cmd() -> std::process::Command {
    let mut c = std::process::Command::new("tmux");
    if !cfg!(debug_assertions) {
        c.args(["-L", "instant-prod"]);
    }
    c
}

#[tauri::command]
pub fn list_sessions() -> Vec<Session> {
    let out = tmux_cmd()
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
    let out = tmux_cmd()
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

/// Decode as much valid UTF-8 from `pending` as possible and return it, leaving
/// only an incomplete trailing multibyte sequence (at most 3 bytes) in `pending`
/// for the next read to complete. Without this, a char split across an 8KB read
/// boundary was decoded as U+FFFD on both sides (the random ?? glyphs). Genuine
/// invalid bytes mid-stream are passed through as a single U+FFFD so the stream
/// never stalls.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // SAFETY-equivalent: bytes [..valid] are valid UTF-8 by definition.
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                match e.error_len() {
                    // Incomplete sequence at the very end: keep it for next time.
                    None => {
                        pending.drain(..valid);
                        break;
                    }
                    // A real invalid byte mid-stream: emit one replacement char and
                    // skip past it, then keep decoding the rest.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + bad);
                    }
                }
            }
        }
    }
    out
}

/// Turn on mouse mode for a session so the wheel scrolls the pane / forwards to
/// mouse-aware TUIs (claude, opencode). Per-session (not `-g`) to leave the
/// user's other tmux sessions alone. Retries: a freshly-created session may not
/// exist yet the instant new-session is spawned.
fn enable_mouse(name: &str) {
    let name = name.to_string();
    std::thread::spawn(move || {
        for _ in 0..15 {
            let ok = tmux_cmd()
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
        let _ = tmux_cmd()
            .args(["set-option", "-g", "set-clipboard", "on"])
            .env("PATH", path_env())
            .status();
    });
}

/// Kill orphaned graphics children (awrit) left by a previous app crash/restart.
/// awrit ignores SIGHUP, so when our process dies its awrit children reparent to
/// launchd (ppid 1) and keep running, holding their single-instance profile lock
/// and blocking new launches. Reap them on startup. Targets the main browser
/// process (not the CEF Helper subprocesses, which exit with their parent).
pub fn reap_orphan_graphics() {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        return;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (it.next(), it.next()) else { continue };
        if ppid != "1" {
            continue; // only launchd-reparented orphans
        }
        if !line.contains("/MacOS/awrit") || line.contains("Helper") {
            continue;
        }
        if let Ok(pid) = pid.parse::<i32>() {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
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
        // Match tmux_cmd's socket so the pty's own server is the same one all the
        // management commands talk to (prod = private socket; dev = default).
        if !cfg!(debug_assertions) {
            c.args(["-L", "instant-prod"]);
        }
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    // Keep the child only for graphics (direct spawn) so close_pty can kill it.
    // tmux's child is a client we want to detach (drop), not kill.
    let child = if graphics { Some(child) } else { None };

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    store
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), PtyHandle { writer: writer.clone(), master: pair.master, child });

    if !graphics {
        enable_mouse(&name); // wheel scrolls the pane / forwards to mouse-aware TUIs
    }

    // Reader thread: pump pty -> webview until EOF (session detached/killed).
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Bytes left over when a multibyte UTF-8 char straddles a read boundary;
        // carried to the next read so it isn't mangled into U+FFFD (the random
        // ?? glyphs). See drain_utf8.
        let mut pending: Vec<u8> = Vec::new();
        if !graphics {
            // Fast path: plain terminal, no graphics parsing.
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let chunk = drain_utf8(&mut pending);
                        if !chunk.is_empty() {
                            let _ = app.emit("pty-data", PtyData { id: id.clone(), chunk });
                        }
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
                                pending.extend_from_slice(&bytes);
                                let chunk = drain_utf8(&mut pending);
                                if chunk.is_empty() {
                                    continue;
                                }
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

/// Drop the pty for a tab. A tmux session (and claude/opencode inside) keeps
/// running; a direct-spawn graphics child (awrit) is killed so it can't orphan
/// and hold its single-instance profile lock.
#[tauri::command]
pub fn close_pty(store: State<PtyStore>, id: String) {
    if let Some(mut h) = store.0.lock().unwrap().remove(&id) {
        if let Some(mut child) = h.child.take() {
            let _ = child.kill();
        }
    }
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
    let _ = tmux_cmd()
        .args(["copy-mode", "-e", "-t", &name])
        .env("PATH", &path)
        .status();
    let _ = tmux_cmd()
        .args(["send-keys", "-t", &name, "-X", "-N", &n, dir])
        .env("PATH", &path)
        .status();
}

/// Kill a tmux session outright (ends the shell/agent inside) and drop its pty.
#[tauri::command]
pub fn kill_session(store: State<PtyStore>, name: String) -> Result<(), String> {
    tmux_cmd()
        .args(["kill-session", "-t", &name])
        .env("PATH", path_env())
        .status()
        .map_err(|e| e.to_string())?;
    store.0.lock().unwrap().remove(&format!("s:{name}"));
    Ok(())
}

/// A claude/opencode process running directly on a real terminal, outside any
/// tmux session — typed straight into Terminal.app/iTerm rather than opened
/// through instant. The frontend flags these so an off-the-grid agent doesn't
/// go unnoticed, and offers to adopt the cwd as a proper tracked tmux session.
#[derive(Serialize, Clone)]
pub struct RogueSession {
    pid: i32,
    tty: String,     // bare device name, e.g. "ttys023"
    command: String, // "claude" | "opencode"
    args: String,    // full command line, for display
    cwd: Option<String>,
}

/// ttys already inside SOME tmux session: the default socket (the user's own
/// ambient tmux, which a prod build's isolated `-L instant-prod` socket can't
/// see) unioned with instant's own socket (so a prod build doesn't mistake its
/// own isolated sessions for rogue ones). Bare device names, not "/dev/...".
fn tmux_ttys() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let mut cmds = vec![std::process::Command::new("tmux")];
    if !cfg!(debug_assertions) {
        cmds.push(tmux_cmd());
    }
    for mut c in cmds {
        let Ok(out) = c
            .args(["list-panes", "-a", "-F", "#{pane_tty}"])
            .env("PATH", path_env())
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(tty) = line.strip_prefix("/dev/") {
                set.insert(tty.to_string());
            }
        }
    }
    set
}

/// cwd of a running pid via `lsof` (macOS has no /proc). Best-effort: None on
/// any failure (permission, process exited mid-scan, lsof missing).
fn process_cwd(pid: i32) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
}

/// claude/opencode processes attached to a real terminal that isn't part of
/// any tmux session. Lets the frontend surface "you're running an agent off
/// the grid" and offer to adopt its cwd into a tracked tmux worktree session.
#[tauri::command]
pub fn rogue_agent_sessions() -> Vec<RogueSession> {
    let known_ttys = tmux_ttys();
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,tty=,args="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid: i32 = it.next()?.parse().ok()?;
            let tty = it.next()?.to_string();
            if tty == "??" || known_ttys.contains(&tty) {
                return None;
            }
            let args = it.collect::<Vec<_>>().join(" ");
            let bin = args.split_whitespace().next()?.rsplit('/').next()?;
            if bin != "claude" && bin != "opencode" {
                return None;
            }
            Some(RogueSession { pid, tty, command: bin.to_string(), args, cwd: process_cwd(pid) })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // path_env() reads the real process PATH, so this test owns mutating it and
    // restores the original value afterward (single test, no interleaving with
    // itself — the only other thing in this crate that could race on PATH).
    #[test]
    fn path_env_prepends_extra_dirs_to_existing_path() {
        let saved = std::env::var("PATH").ok();

        std::env::set_var("PATH", "/custom/bin:/another/bin");
        assert_eq!(path_env(), format!("{EXTRA_PATH}:/custom/bin:/another/bin"));

        std::env::remove_var("PATH");
        assert_eq!(path_env(), EXTRA_PATH);

        match saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
    }

    #[test]
    fn pixel_dims_multiplies_cell_size_by_grid() {
        assert_eq!(pixel_dims(80, 24, Some(8), Some(16)), (640, 384));
    }

    #[test]
    fn pixel_dims_defaults_to_zero_when_cell_size_unknown() {
        assert_eq!(pixel_dims(80, 24, None, None), (0, 0));
        // Height falls back to 0 independently of a known width, and vice versa.
        assert_eq!(pixel_dims(80, 24, Some(8), None), (640, 0));
        assert_eq!(pixel_dims(80, 24, None, Some(16)), (0, 384));
    }

    #[test]
    fn pixel_dims_saturates_instead_of_overflowing() {
        assert_eq!(pixel_dims(u16::MAX, 1, Some(2), Some(1)), (u16::MAX, 1));
    }

    #[test]
    fn drain_utf8_decodes_a_complete_buffer() {
        let mut pending = b"hello".to_vec();
        assert_eq!(drain_utf8(&mut pending), "hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_holds_back_a_split_multibyte_char() {
        // "a\u{20ac}b" ('a', euro sign (3 bytes: E2 82 AC), 'b'). Feed 'a' plus
        // just the first byte of the euro sign, as a read boundary would.
        let full = "a\u{20ac}b".as_bytes().to_vec();
        let mut pending = full[..2].to_vec();

        let first = drain_utf8(&mut pending);
        assert_eq!(first, "a");
        assert_eq!(pending, vec![full[1]]); // incomplete lead byte retained

        pending.extend_from_slice(&full[2..]);
        let second = drain_utf8(&mut pending);
        assert_eq!(second, "\u{20ac}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_replaces_invalid_byte_and_keeps_decoding() {
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(drain_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }
}
