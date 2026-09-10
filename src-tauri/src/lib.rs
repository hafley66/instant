mod activity;
#[path = "0_boop.rs"]
mod boop;
#[path = "0_tmux.rs"]
mod boop_tmux;
mod capture;
mod cdp;
mod config;
mod deps;
mod favorites;
mod fs;
mod fs_watch;
mod host;
mod refresolve;
mod harness;
#[path = "0_harness_store.rs"]
pub mod harness_store;
mod kitty;
mod ledger;
#[path = "0_pty_events.rs"]
mod pty_events;
pub use boop_harness::transcript::Message as AiMessage;
mod meme;
mod pty;
// sprefa integration disabled for now (2026-07-18): commands kept compiling
// but unregistered; re-enable by restoring the invoke_handler entries below.
#[allow(dead_code)]
mod sprefa_plugin;
mod workspace;
mod worktrees;
mod services;
pub mod serve;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_foundation::runloop::CFRunLoop;
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CallbackResult,
};
use mouse_position::mouse_position::Mouse;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

// Two right-clicks closer than this count as a double-right-click summon gesture.
const DOUBLE_RIGHT_MS: u64 = 350;
// Two right-⌘ taps closer than this count as a double-right-⌘ summon. Modifier
// taps run a touch slower than mouse clicks, so the window is a bit wider.
const DOUBLE_RCMD_MS: u64 = 400;
// IOKit device-dependent flag bit for the RIGHT command key (NX_DEVICERCMDKEYMASK).
// Present in HID-tap event flags, so it isolates right ⌘ from left ⌘.
const RCMD_BIT: u64 = 0x10;

/// The summon gestures' clock: the previous right-click and the previous
/// right-⌘ press edge. Nothing else about input is read or kept.
#[derive(Default)]
struct SummonGesture {
    last_right_down: Option<Instant>,
    right_cmd_down: bool,
    last_right_cmd: Option<Instant>,
}

fn is_double(previous: &mut Option<Instant>, window_ms: u64) -> bool {
    let now = Instant::now();
    let double = previous
        .map(|t| now.duration_since(t) < Duration::from_millis(window_ms))
        .unwrap_or(false);
    // A hit resets the clock so a triple never counts as two doubles.
    *previous = if double { None } else { Some(now) };
    double
}

/// A listen-only HID event tap on its own thread that watches two events,
/// right mouse down and modifier flag changes, for the two summon gestures:
/// double right-click and double right-⌘. Every event passes through untouched.
/// macOS disables a tap whose callback stalls; the loop re-creates it.
fn spawn_summon_tap(app: AppHandle) {
    std::thread::spawn(move || {
        // A slow tap callback delays every click systemwide on a loaded machine.
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
        }
        let gesture = Mutex::new(SummonGesture::default());
        let alive = AtomicBool::new(false);
        loop {
            let created = CGEventTap::with_enabled(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::RightMouseDown, CGEventType::FlagsChanged],
                |_proxy, ty, event| {
                    let mut g = gesture.lock().unwrap();
                    match ty {
                        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                            alive.store(false, Ordering::Relaxed);
                            CFRunLoop::get_current().stop();
                        }
                        CGEventType::RightMouseDown => {
                            if is_double(&mut g.last_right_down, DOUBLE_RIGHT_MS) {
                                log_event(&app, "INFO", "double_right_click_detected", serde_json::json!({}));
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || toggle_window(&handle));
                            }
                        }
                        CGEventType::FlagsChanged => {
                            // Right ⌘ carries its own device bit, so this stays
                            // unambiguous while left ⌘ is held. Only the press edge
                            // counts.
                            let rcmd = event.get_flags().bits() & RCMD_BIT != 0;
                            if rcmd && !g.right_cmd_down && is_double(&mut g.last_right_cmd, DOUBLE_RCMD_MS) {
                                log_event(&app, "INFO", "double_right_command_detected", serde_json::json!({}));
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || toggle_window(&handle));
                            }
                            g.right_cmd_down = rcmd;
                        }
                        _ => {}
                    }
                    CallbackResult::Keep
                },
                || {
                    alive.store(true, Ordering::Relaxed);
                    log_event(&app, "INFO", "summon_tap_active", serde_json::json!({}));
                    CFRunLoop::run_current()
                },
            );
            if created.is_err() {
                log_event(
                    &app,
                    "ERROR",
                    "summon_tap_create_failed",
                    serde_json::json!({ "reason": "grant Accessibility / Input Monitoring permission" }),
                );
                eprintln!("summon gestures disabled: event tap creation failed (grant Accessibility / Input Monitoring permission)");
                return;
            }
            if alive.load(Ordering::Relaxed) {
                log_event(&app, "WARN", "summon_tap_runloop_ended", serde_json::json!({}));
                return;
            }
            log_event(&app, "WARN", "summon_tap_disabled", serde_json::json!({}));
        }
    });
}

// The app that was frontmost when we last summoned the overlay. On dismiss we
// reactivate it so focus lands back where the user was (e.g. Chrome) instead of
// the desktop — an accessory app's hidden window doesn't restore focus itself.
static PREV_APP: Mutex<Option<String>> = Mutex::new(None);

// Serialize append/truncate cycles so concurrent frontend and native events
// cannot reorder bytes or truncate a newer write.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Build a filled-circle tray icon in `color`, transparent outside the disc.
fn dot_icon(color: [u8; 3]) -> tauri::image::Image<'static> {
    const N: usize = 32;
    let mut buf = vec![0u8; N * N * 4];
    let c = (N as f32 - 1.0) / 2.0;
    for y in 0..N {
        for x in 0..N {
            let (dx, dy) = (x as f32 - c, y as f32 - c);
            if (dx * dx + dy * dy).sqrt() <= c - 1.0 {
                let i = (y * N + x) * 4;
                buf[i] = color[0];
                buf[i + 1] = color[1];
                buf[i + 2] = color[2];
                buf[i + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(buf, N as u32, N as u32)
}

/// Reflect capture state in the menu bar: a red dot while recording, the default
/// app icon when idle. Called from `capture_set_enabled`.
pub fn set_recording_indicator(app: &AppHandle, on: bool) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    if on {
        let _ = tray.set_icon(Some(dot_icon([220, 40, 40])));
    } else {
        let _ = tray.set_icon(app.default_window_icon().cloned());
    }
    let _ = tray.set_icon_as_template(false); // keep the red colored, not monochrome
}

/// While the overlay is up, let it join the OS app/window switcher; on hide,
/// drop back to a background accessory. macOS: Cmd-Tab + Dock tile follow the
/// activation policy (Regular vs Accessory). Win/Linux: Alt-Tab + taskbar follow
/// skip_taskbar. Called from every show/hide path so the entry never lingers.
fn set_switcher_visible(app: &AppHandle, on: bool) {
    #[cfg(target_os = "macos")]
    {
        // Demoting works cleanly here because we only call this with on=false from
        // the focus-lost handler, i.e. once we've already resigned active. (Flipping
        // to Accessory while still frontmost would leave the entry up.)
        let policy = if on {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_skip_taskbar(!on);
    }
}

#[cfg(target_os = "macos")]
fn activate_window(win: &tauri::WebviewWindow) -> serde_json::Value {
    use objc2_app_kit::{NSApplication, NSWindow};
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return serde_json::json!({ "error": "not_main_thread" });
    };
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let Ok(ns_window_ptr) = win.ns_window() else {
        return serde_json::json!({ "error": "ns_window_unavailable", "app_active": app.isActive() });
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    ns_window.makeKeyAndOrderFront(None);
    serde_json::json!({
        "app_active": app.isActive(),
        "window_key": ns_window.isKeyWindow(),
        "window_main": ns_window.isMainWindow(),
    })
}

#[cfg(not(target_os = "macos"))]
fn activate_window(_win: &tauri::WebviewWindow) -> serde_json::Value {
    serde_json::json!({ "unsupported": true })
}

/// Toggle the summon window. When showing, anchor it to the mouse cursor.
fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        log_event(
            app,
            "ERROR",
            "toggle_window_missing",
            serde_json::json!({ "label": "main" }),
        );
        return;
    };

    let visible = match win.is_visible() {
        Ok(value) => {
            log_event(
                app,
                "INFO",
                "toggle_window_visibility",
                serde_json::json!({ "visible": value }),
            );
            value
        }
        Err(error) => {
            log_event(
                app,
                "ERROR",
                "toggle_window_visibility_failed",
                serde_json::json!({ "error": format!("{error:?}") }),
            );
            false
        }
    };
    if visible {
        let result = win.hide(); // focus-lost handler demotes us out of the switcher
        log_event(
            app,
            if result.is_ok() { "INFO" } else { "ERROR" },
            "toggle_window_hide",
            serde_json::json!({ "result": result.as_ref().map(|_| "ok").unwrap_or("error"), "error": result.err().map(|e| format!("{e:?}")) }),
        );
        reactivate_prev_app();
        return;
    }

    // Remember who was frontmost so dismiss can hand focus back. Our window is
    // still hidden here, so this is the user's real prior app, not us.
    {
        let name = capture::frontmost_app();
        if !name.is_empty() {
            *PREV_APP.lock().unwrap() = Some(name);
        }
    }

    if let Mouse::Position { x, y } = Mouse::get_mouse_position() {
        position_at_cursor(&win, x as f64, y as f64);
    }

    set_switcher_visible(app, true);
    let show_result = win.show();
    log_event(
        app,
        if show_result.is_ok() { "INFO" } else { "ERROR" },
        "toggle_window_show",
        serde_json::json!({ "result": show_result.as_ref().map(|_| "ok").unwrap_or("error"), "error": show_result.err().map(|e| format!("{e:?}")) }),
    );
    let focus_result = win.set_focus();
    log_event(
        app,
        if focus_result.is_ok() {
            "INFO"
        } else {
            "ERROR"
        },
        "toggle_window_focus",
        serde_json::json!({ "result": focus_result.as_ref().map(|_| "ok").unwrap_or("error"), "error": focus_result.err().map(|e| format!("{e:?}")) }),
    );
    // Tell the front to play its entrance animation + refocus the active term.
    let emit_result = win.emit("summoned", ());
    log_event(
        app,
        if emit_result.is_ok() { "INFO" } else { "ERROR" },
        "toggle_window_emit_summoned",
        serde_json::json!({ "result": emit_result.as_ref().map(|_| "ok").unwrap_or("error"), "error": emit_result.err().map(|e| format!("{e:?}")) }),
    );
}

// Poll the frontmost app and emit `frontmost-app` (the owner name) on every
// change. Polling (vs an NSWorkspace observer) keeps this off the objc delegate
// path and reuses capture::frontmost_app() — 400ms is well under human focus-
// switch cadence. The front drives the overlay state machine off this stream.
// Our own window is reported as "instant" while focused; the front ignores self.
fn spawn_frontmost_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let cur = capture::frontmost_app();
            if !cur.is_empty() && cur != last {
                last = cur.clone();
                let _ = app.emit("frontmost-app", cur);
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
}

// Bring the pre-summon app back to the foreground. `open -a <name>` reactivates
// a running app with no extra TCC prompt (osascript/System Events would need
// Automation access). Best-effort: a missing/renamed app just no-ops.
fn reactivate_prev_app() {
    let Some(name) = PREV_APP.lock().unwrap().take() else {
        return;
    };
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg("-a")
            .arg(&name)
            .output();
    });
}

/// Place the window so a corner sits at the cursor and it grows into the screen,
/// flipping near the right/bottom edge and clamping to the monitor. The cursor
/// coords are logical points, so we work in logical units (a PhysicalPosition
/// here lands the window at half-offset on a 2x display => it drifts to center).
fn position_at_cursor(win: &WebviewWindow, cx: f64, cy: f64) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let Ok(size) = win.outer_size() else {
        let _ = win.set_position(LogicalPosition::new(cx, cy));
        return;
    };
    let size = size.to_logical::<f64>(scale);

    let (mx, my, mw, mh) = match win.current_monitor().ok().flatten() {
        Some(m) => {
            let p = m.position().to_logical::<f64>(scale);
            let s = m.size().to_logical::<f64>(scale);
            (p.x, p.y, s.width, s.height)
        }
        None => (0.0, 0.0, f64::MAX, f64::MAX),
    };

    let margin = 12.0;
    // Default: top-left corner near the cursor (grow down-right). Flip if it
    // would overflow the right/bottom edge.
    let mut left = cx - margin;
    if left + size.width > mx + mw {
        left = cx - size.width + margin;
    }
    let mut top = cy - margin;
    if top + size.height > my + mh {
        top = cy - size.height + margin;
    }
    left = left.max(mx).min(mx + mw - size.width);
    top = top.max(my).min(my + mh - size.height);

    let _ = win.set_position(LogicalPosition::new(left, top));
}

// Drop a trailing :line or :line:col (editor/grep style) so "src/main.ts:42:5"
// resolves as "src/main.ts". Only strips when the tail is all digits.
fn strip_line_suffix(s: &str) -> &str {
    let mut base = s;
    for _ in 0..2 {
        match base.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
                base = head;
            }
            _ => break,
        }
    }
    base
}

// Expand a leading ~ and resolve relative paths against the pane cwd.
fn resolve_path(raw: &str, cwd: &str) -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;
    let home = || std::env::var_os("HOME").map(PathBuf::from).ok_or("no HOME");
    let p = if raw == "~" {
        home()?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        PathBuf::from(raw)
    };
    Ok(if p.is_absolute() {
        p
    } else {
        PathBuf::from(cwd).join(p)
    })
}

/// Open a path or URL the user ⌘-clicked in a terminal, iTerm2-style. URLs go to
/// the default browser; existing paths open in their default app (Finder for a
/// dir) via Launch Services. Relative paths + `~` resolve against the pane cwd;
/// a trailing `:line[:col]` is stripped before the existence check. Hides the
/// summon window so the opened app comes forward. Returns "url" | "path" for the
/// front to log, or Err when nothing resolved (the caller ignores it silently).
#[tauri::command]
async fn open_target(app: AppHandle, target: String, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || open_target_blocking(app, target, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn open_target_blocking(app: AppHandle, target: String, cwd: String) -> Result<String, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("empty".into());
    }
    // URL: a bare www. host, or an explicit scheme://… with an alnum+[-+.] scheme.
    let scheme_ok = t.split_once("://").is_some_and(|(s, _)| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let hide_window = || {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide(); // focus-lost handler demotes us out of the switcher
        }
    };
    if t.starts_with("www.") || scheme_ok {
        let url = if t.starts_with("www.") {
            format!("https://{t}")
        } else {
            t.to_string()
        };
        std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        hide_window();
        return Ok("url".into());
    }
    let path = resolve_path(strip_line_suffix(t), &cwd)?;
    if !path.exists() {
        return Err(format!("not found: {}", path.display()));
    }
    std::process::Command::new("/usr/bin/open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    hide_window();
    Ok("path".into())
}

/// Run a ⌘-click action: a shell command (from the front's clickRules table, with
/// the clicked token already shell-quoted into it) via `sh -c` in the pane cwd,
/// using the login PATH so rg/code/open resolve under the GUI's stripped env.
/// Returns stdout (capped); the caller opens a panel only when it's non-empty, so
/// launchers (open/code) just launch and producers (rg) show results.
#[tauri::command]
async fn run_click(command: String, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_click_blocking(command, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn run_click_blocking(command: String, cwd: String) -> Result<String, String> {
    let dir = match cwd.trim() {
        "" => std::env::var("HOME").unwrap_or_else(|_| ".".into()),
        c => c.to_string(),
    };
    let out = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&dir)
        .env("PATH", pty::path_env())
        .output()
        .map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    const CAP: usize = 200_000;
    if s.len() > CAP {
        s.truncate(CAP);
        s.push_str("\n… (truncated)");
    }
    // A failed command is an error the caller sees, never an empty success:
    // the exit code and the tail of stderr ride in the message.
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let code = out.status.code().map_or("signal".to_string(), |c| c.to_string());
        return Err(format!("exit {code}: {}\n{}", tail.join("\n").trim(), s.trim()).trim().to_string());
    }
    Ok(s)
}

/// Per-build state directory. A release ("prod") build nests all of its state
/// (headless-Chrome profile, sqlite dbs, config.json, captures, log) under a
/// `prod` subfolder so it can run alongside a `tauri dev` ("dev") instance
/// without the two trashing each other. Dev keeps the bare app_data_dir, so a
/// running dev instance is unaffected by this split. Discriminated by
/// cfg!(debug_assertions): true under `tauri dev`, false in a release bundle.
pub fn state_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !cfg!(debug_assertions) {
        dir.push("prod");
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn log_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(state_dir(app)?.join("instant.log"))
}

fn log_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// Write a structured native event to the same file used by frontend errors.
/// The fields remain JSON so stack traces and backend errors cannot corrupt the
/// one-event-per-line format.
fn log_event(app: &AppHandle, level: &str, event: &str, fields: serde_json::Value) {
    let line = format!(
        "ts={} level={} target=instant event={} fields={}",
        log_timestamp_ms(),
        level,
        event,
        serde_json::to_string(&fields).unwrap_or_else(|_| "{}".to_string()),
    );
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || log_append_blocking(app, line));
}

/// Append one line to app_data_dir/instant.log. The webview has no console a user
/// can reach, so errors/events are mirrored here. Best-effort: logging never
/// throws back into the app. Caps the file so it can't grow unbounded.
#[tauri::command]
async fn log_append(app: AppHandle, line: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || log_append_blocking(app, line)).await;
}

fn log_append_blocking(app: AppHandle, line: String) {
    let _guard = LOG_LOCK.lock().unwrap();
    let Ok(path) = log_file_path(&app) else {
        return;
    };
    // Trim from the front if it crosses the cap (cheap: rewrite tail on overflow).
    const CAP: u64 = 2_000_000;
    if std::fs::metadata(&path)
        .map(|m| m.len() > CAP)
        .unwrap_or(false)
    {
        if let Ok(data) = std::fs::read(&path) {
            let keep = data.len().saturating_sub(CAP as usize / 2);
            let _ = std::fs::write(&path, &data[keep..]);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

/// Absolute path of the log file, for display / tailing.
#[tauri::command]
fn log_path(app: AppHandle) -> Result<String, String> {
    Ok(log_file_path(&app)?.to_string_lossy().into_owned())
}

/// Reveal the log file in Finder. Best-effort.
#[tauri::command]
async fn log_reveal(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || log_reveal_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

fn log_reveal_blocking(app: AppHandle) -> Result<(), String> {
    let p = log_file_path(&app)?;
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Interactive screen-region capture to a temp PNG; returns the file path.
/// Uses macOS `screencapture -i` (the crosshair selector). If the user presses
/// Esc no file is written, which we report as an error so the front skips it.
/// Needs Screen Recording permission for the app, granted on first use.
#[tauri::command]
async fn screenshot() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(screenshot_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn screenshot_blocking() -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("instant-shot-{ts}.png"));
    // Absolute path: GUI apps don't get /usr/sbin in PATH, so a bare
    // "screencapture" silently fails to launch (nothing happens on click).
    std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    if path.exists() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err("screenshot cancelled".into())
    }
}

// ---- command wrappers (host-trait lane) --------------------------------
// Each owned-file command whose body needs the AppHandle lives here as a thin
// wrapper; the logic sits in a `*_impl(host: &dyn Host, services: &Services, …)`
// in the owning module. State-only commands stay in their module.

#[tauri::command]
async fn fav_add(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    msg: AiMessage,
    cwd: String,
) -> Result<Vec<favorites::Fav>, String> {
    favorites::fav_add_impl(&host::TauriHost(app), &services, msg, cwd)
}

#[tauri::command]
async fn fav_remove(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    editor: String,
    session_id: String,
    message_id: String,
) -> Result<Vec<favorites::Fav>, String> {
    favorites::fav_remove_impl(&host::TauriHost(app), &services, editor, session_id, message_id)
}

#[tauri::command]
async fn create_workspace(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    repo: String,
    branch: String,
    agent: String,
) -> Result<workspace::Workspace, String> {
    workspace::create_workspace_impl(&host::TauriHost(app), &services, repo, branch, agent)
}

#[tauri::command]
async fn remove_workspace(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    id: String,
    delete_tree: bool,
) -> Result<(), String> {
    workspace::remove_workspace_impl(&host::TauriHost(app), &services, id, delete_tree)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn cdp_open(
    app: AppHandle,
    services: tauri::State<Arc<services::Services>>,
    id: String,
    url: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
) -> Result<(), String> {
    let h: Arc<dyn host::Host> = Arc::new(host::TauriHost(app));
    cdp::cdp_open_impl(h, (*services).clone(), id, url, width, height, dpr, quality)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn open_session(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    id: String,
    name: String,
    tmux_target: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    graphics: Option<bool>,
    cell_w: Option<u16>,
    cell_h: Option<u16>,
    attach_only: Option<bool>,
) -> Result<(), String> {
    let h: Arc<dyn host::Host> = Arc::new(host::TauriHost(app));
    pty::open_session_impl(
        h,
        (*services).clone(),
        id,
        name,
        tmux_target,
        command,
        cwd,
        cols,
        rows,
        graphics,
        cell_w,
        cell_h,
        attach_only,
    )
}

#[tauri::command]
fn fs_watch_claim(
    app: AppHandle,
    services: tauri::State<Arc<services::Services>>,
    claim_id: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let h: Arc<dyn host::Host> = Arc::new(host::TauriHost(app));
    fs_watch::fs_watch_claim_impl(h, &services, claim_id, path, recursive)
}

#[tauri::command]
async fn activity_log(
    app: AppHandle,
    services: tauri::State<'_, Arc<services::Services>>,
    source: String,
    kind: String,
    title: String,
    text: String,
) -> Result<(), String> {
    activity::activity_log_impl(&host::TauriHost(app), &services, source, kind, title, text)
}

#[tauri::command]
fn capture_set_enabled(app: AppHandle, services: tauri::State<Arc<services::Services>>, on: bool) {
    activity::capture_set_enabled_impl(&host::TauriHost(app), &services, on);
}

#[tauri::command]
async fn resolve_ref(
    app: AppHandle,
    token: String,
    cwd: String,
    sessions: Option<Vec<String>>,
) -> Result<refresolve::ResolveResult, String> {
    let h = host::TauriHost(app);
    refresolve::resolve_ref_impl(&h, token, cwd, sessions).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The daily driver owns Cmd+Alt+Space. An isolated dev instance uses
    // Cmd+Shift+Space and skips the other process-wide singleton surfaces.
    let isolated = std::env::var("INSTANT_ISOLATED").is_ok();
    let summon_modifiers = if isolated {
        Modifiers::SUPER | Modifiers::SHIFT
    } else {
        Modifiers::SUPER | Modifiers::ALT
    };
    let summon = Shortcut::new(Some(summon_modifiers), Code::Space);
    // Skip the tray icon and global shortcut so a second instance doesn't fight
    // the owner's always-running one over the same OS-level resources.
    let no_globals = std::env::var("INSTANT_NO_GLOBALS").is_ok();
    let skip_shared_globals = no_globals || isolated;

    let builder = tauri::Builder::default();

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_filter(move |label| !skip_shared_globals && label == "main")
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &summon && event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            log_event(
                app.handle(),
                "INFO",
                "startup",
                serde_json::json!({
                    "isolated": isolated,
                    "no_globals": no_globals,
                    "skip_shared_globals": skip_shared_globals,
                    "debug_assertions": cfg!(debug_assertions),
                }),
            );
            let data_dir = state_dir(app.handle())?;
            let services = crate::services::Services::boot(&data_dir)?;
            let services = Arc::new(services);
            let host: Arc<dyn crate::host::Host> =
                Arc::new(crate::host::TauriHost(app.handle().clone()));

            services.pty_events.start(host.clone());
            app.manage(services.clone());
            if !no_globals {
                app.global_shortcut().register(summon)?;
            }

            if skip_shared_globals {
                eprintln!(
                    "isolated globals: skipping tray icon and the summon gestures, showing the main window on launch instead"
                );
            } else {
                spawn_summon_tap(app.handle().clone());
            }

            // Track focus on our own window for the front's focus-driven state.
            let focused = services.window_focused.0.clone();
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::Focused(f) = e {
                        focused.store(*f, Ordering::Relaxed);
                        // Participate in the OS switcher (Cmd-Tab / Alt-Tab / taskbar)
                        // only while focused; drop out the instant we lose focus
                        // (tab-away or dismiss). Demote-on-blur lands cleanly since
                        // we've resigned active by then. Hop to the main thread:
                        // AppKit activation-policy calls must run there.
                        let on = *f;
                        let app2 = app_handle.clone();
                        let _ = app_handle
                            .run_on_main_thread(move || set_switcher_visible(&app2, on));
                    }
                });
            }

            // Stream frontmost-app changes to the front so the overlay can react
            // to focus (e.g. raise/fade when VSCode comes forward).
            spawn_frontmost_watch(app.handle().clone());

            if !skip_shared_globals {
                activity::spawn_server(host.clone(), services.clone());
            }
            pty::reap_orphan_graphics(); // clean awrit orphans from a prior crash/restart
            cdp::reap_orphans(); // clean headless-Chrome orphans from a prior SIGTERM

            // A directly shown secondary instance must become a regular app
            // before set_focus(), otherwise AppKit may report focus success
            // while leaving the accessory process unable to receive keys.
            let _ = app.set_activation_policy(if skip_shared_globals {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            });

            if skip_shared_globals {
                // No tray, so show directly. INSTANT_ISOLATED
                // still has its separate Cmd+Shift+Space global shortcut.
                if let Some(win) = app.get_webview_window("main") {
                    let show_result = win.show();
                    log_event(
                        app.handle(),
                        if show_result.is_ok() { "INFO" } else { "ERROR" },
                        "startup_window_show",
                        serde_json::json!({ "result": show_result.as_ref().map(|_| "ok").unwrap_or("error"), "error": show_result.err().map(|e| format!("{e:?}")) }),
                    );
                    let focus_result = win.set_focus();
                    let native_focus = activate_window(&win);
                    log_event(
                        app.handle(),
                        if focus_result.is_ok() { "INFO" } else { "ERROR" },
                        "startup_window_focus",
                        serde_json::json!({ "result": focus_result.as_ref().map(|_| "ok").unwrap_or("error"), "error": focus_result.err().map(|e| format!("{e:?}")), "native": native_focus }),
                    );
                }
                return Ok(());
            }

            let toggle_i = MenuItem::with_id(app, "toggle", "Summon / Hide", true, None::<&str>)?;
            let record_i =
                MenuItem::with_id(app, "record", "Toggle Recording", true, None::<&str>)?;
            let ai_i =
                MenuItem::with_id(app, "ai", "Toggle AI Integrations", true, None::<&str>)?;
            // Recovery: reload skipping persisted layout/state (safe), or wipe it.
            let safe_i =
                MenuItem::with_id(app, "safe", "Safe Reopen (skip restore)", true, None::<&str>)?;
            let reset_i =
                MenuItem::with_id(app, "reset", "Reset All State…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&toggle_i, &record_i, &ai_i, &safe_i, &reset_i, &quit_i],
            )?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    // Route through the webview so the persisted flag stays the
                    // single source of truth; capture_set_enabled swaps the icon.
                    "record" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("toggle-record", ());
                        }
                    }
                    // Route through the webview so the persisted store stays the
                    // single source of truth (Rust doesn't read localStorage).
                    "ai" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("toggle-ai", ());
                        }
                    }
                    // Set the one-shot flag in sessionStorage (survives reload, not
                    // restart) then reload. eval'd directly so it works even when the
                    // app JS is wedged by bad persisted state. state.ts reads it
                    // before touching localStorage.
                    "safe" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win
                                .eval("sessionStorage.setItem('SAFE_BOOT','1');location.reload()");
                        }
                    }
                    "reset" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.eval(
                                "if(confirm('Reset all instant state (layout, tabs, settings)? tmux sessions are unaffected.')){localStorage.clear();sessionStorage.clear();location.reload()}",
                            );
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click the menu-bar icon toggles the summon window.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::list_sessions,
            open_session,
            pty::write_pty,
            pty::resize_pty,
            pty::close_pty,
            pty::kill_session,
            pty::scroll_session,
            pty::tmux_buffer,
            pty::rename_session_window,
            pty::rogue_agent_sessions,
            pty_events::pty_event_stats,
            cdp_open,
            cdp::cdp_send,
            cdp::cdp_resize,
            cdp::cdp_navigate,
            cdp::cdp_close,
            cdp::cdp_status,
            workspace::list_workspaces,
            create_workspace,
            remove_workspace,
            worktrees::scan_worktrees,
            worktrees::add_worktree,
            worktrees::git_diff,
            worktrees::remove_worktree,
            worktrees::worktree_at,
            activity::activity_events,
            activity::activity_clear,
            activity_log,
            capture_set_enabled,
            activity::capture_enabled,
            activity::rules_get,
            activity::rules_set,
            activity::activity_rule_matches,
            activity::watcher_status,
            capture::capture_permissions,
            capture::capture_request_screen,
            config::config_get,
            config::config_set,
            config::config_reload,
            config::config_open,
            fs::list_dir,
            fs::list_dir_meme,
            fs::list_dir_recursive,
            fs::search_files,
            fs::read_image,
            fs::save_text,
            fs::delete_file,
            fs::stash_drop,
            fs::read_text,
            resolve_ref,
            refresolve::clear_ref_index,
            refresolve::read_git_blob,
            fs_watch_claim,
            fs_watch::fs_watch_release,
            harness::harness_session,
            harness::harness_sessions,
            boop::boop_turns,
            boop::boop_turns_recent,
            boop::boop_lanes,
            boop::boop_lane_events,
            boop::boop_sync_session,
            boop::boop_locate_turns,
            boop::boop_favorite_add,
            boop::boop_favorites,
            boop::boop_favorite_toggle,
            boop::boop_tags_recent,
            boop::boop_tags_search,
            boop::boop_tags_apply,
            boop::boop_tags_for,
            boop::boop_turn_comments,
            boop::boop_turn_comment_upsert,
            boop::boop_turn_comment_delete,
            boop::boop_turn_comments_sent,
            boop::boop_turn_annotations,
            boop::boop_turn_comment_forks,
            boop::boop_config_presets,
            boop::boop_agent_touches,
            boop::boop_session_graph,
            boop_tmux::boop_mux_capture,
            boop_tmux::boop_mux_exit_copy_mode,
            harness_store::boop_mux_session,
            boop_tmux::boop_mux_send_keys,
            ledger::list_ai_sessions,
            ledger::read_ai_messages,
            ledger::latest_ai_message,
            meme::make_slack_emoji,
            meme::magick_available,
            meme::install_imagemagick,
            meme::save_meme,
            meme::copy_meme_image,
            fav_add,
            fav_remove,
            favorites::fav_list,
            // sprefa_* unregistered while the integration is disabled:
            // sprefa_plugin::commands::sprefa_schema,
            // sprefa_plugin::commands::sprefa_ping,
            // sprefa_plugin::commands::sprefa_eval,
            // sprefa_plugin::commands::sprefa_query_sql,
            // sprefa_plugin::commands::sprefa_rel_source,
            screenshot,
            open_target,
            run_click,
            log_append,
            log_path,
            log_reveal,
            deps::tool_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tear down the shared headless Chrome when the app exits so it
            // doesn't linger holding its profile/port.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                cdp::kill_engine(&app.state::<Arc<services::Services>>());
            }
        });
}
// todo(split): reduce the Tauri composition root to adapter registration and boot wiring
// todo(codegen): verify ipc/commands.json against generate_handler registrations during build
