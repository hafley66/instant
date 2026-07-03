mod activity;
mod capture;
mod cdp;
mod config;
mod favorites;
mod fs;
mod harness;
mod kitty;
mod ledger;
mod meme;
mod pty;
mod sprefa_plugin;
mod workspace;
mod worktrees;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_foundation::runloop::CFRunLoop;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use mouse_position::mouse_position::Mouse;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

// Two right-clicks closer than this count as a double-right-click summon gesture.
const DOUBLE_RIGHT_MS: u128 = 350;
// Two right-⌘ taps closer than this count as a double-right-cmd summon. Modifier
// taps run a touch slower than mouse clicks, so the window is a bit wider.
const DOUBLE_RCMD_MS: u128 = 400;
// IOKit device-dependent flag bit for the RIGHT command key (NX_DEVICERCMDKEYMASK).
// Present in HID-tap event flags, so it isolates right ⌘ from left ⌘.
const RCMD_BIT: u64 = 0x10;
// IOKit device-dependent flag bit for the RIGHT shift key (NX_DEVICERSHIFTKEYMASK).
const RSHIFT_BIT: u64 = 0x04;
// Global throttle between screen captures, across all gesture kinds.
const MIN_GAP: Duration = Duration::from_millis(350);

// The app that was frontmost when we last summoned the overlay. On dismiss we
// reactivate it so focus lands back where the user was (e.g. Chrome) instead of
// the desktop — an accessory app's hidden window doesn't restore focus itself.
static PREV_APP: Mutex<Option<String>> = Mutex::new(None);

// Tap-thread gesture state (behind a Mutex, since with_enabled takes `impl Fn`).
#[derive(Default)]
struct Gesture {
    last_capture: Option<Instant>,
    drag_active: bool,
    last_right_down: Option<Instant>,
    // Right-⌘ double-tap summon: track press edges + the previous tap time.
    right_cmd_down: bool,
    last_right_cmd: Option<Instant>,
}

// Throttled capture trigger: spawn the screenshot OFF the tap thread so input
// latency isn't affected by screencapture's ~100-300ms.
fn maybe_capture(g: &mut Gesture, app: &AppHandle, enabled: &Arc<AtomicBool>, kind: &str) {
    if !enabled.load(Ordering::Relaxed) {
        return;
    }
    let now = Instant::now();
    if let Some(t) = g.last_capture {
        if now.duration_since(t) < MIN_GAP {
            return;
        }
    }
    g.last_capture = Some(now);
    let app = app.clone();
    let kind = kind.to_string();
    std::thread::spawn(move || capture::take(app, &kind));
}

/// Global input tap on a dedicated thread running its own CFRunLoop. Handles the
/// double-right-click summon (unchanged) plus event-driven capture: drag edges,
/// clicks/dbl-clicks, and Cmd+C / Cmd+V. Listen-only, so it never swallows input
/// and the webview's own context menu still works. We read raw event fields
/// (click-state, keycode, flags) directly — NO TIS/TSM keycode translation — so
/// the old rdev-on-a-background-thread crash does not recur. Needs Accessibility
/// / Input Monitoring permission, same as the hotkey.
fn spawn_input_taps(app: AppHandle, enabled: Arc<AtomicBool>, tap_active: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let g = Mutex::new(Gesture::default());
        let ta = tap_active.clone();
        let res = CGEventTap::with_enabled(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            // Active (not ListenOnly) so the send-highlight combo can be dropped
            // before the focused app turns it into its own paste. Every other
            // event returns Keep, so pass-through is unchanged.
            CGEventTapOptions::Default,
            vec![
                CGEventType::RightMouseDown,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseDragged,
                CGEventType::LeftMouseUp,
                CGEventType::KeyDown,
                CGEventType::FlagsChanged,
            ],
            |_proxy, ty, event| {
                let mut g = g.lock().unwrap();
                match ty {
                    CGEventType::RightMouseDown => {
                        let now = Instant::now();
                        let is_double = g
                            .last_right_down
                            .map(|t| {
                                now.duration_since(t)
                                    < Duration::from_millis(DOUBLE_RIGHT_MS as u64)
                            })
                            .unwrap_or(false);
                        if is_double {
                            g.last_right_down = None; // reset so a triple isn't two doubles
                            let handle = app.clone();
                            let _ = app.run_on_main_thread(move || toggle_window(&handle));
                        } else {
                            g.last_right_down = Some(now);
                        }
                    }
                    CGEventType::LeftMouseDown => g.drag_active = false,
                    CGEventType::LeftMouseDragged => {
                        if !g.drag_active {
                            g.drag_active = true; // leading edge of a drag burst
                            maybe_capture(&mut g, &app, &enabled, "drag");
                        }
                    }
                    CGEventType::LeftMouseUp => {
                        if g.drag_active {
                            g.drag_active = false; // trailing edge
                            maybe_capture(&mut g, &app, &enabled, "drag-end");
                        } else {
                            let cs = event
                                .get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE);
                            maybe_capture(
                                &mut g,
                                &app,
                                &enabled,
                                if cs >= 2 { "dblclick" } else { "click" },
                            );
                        }
                    }
                    CGEventType::FlagsChanged => {
                        // Right ⌘ has its own device bit, so this is unambiguous
                        // even while left ⌘ is held. Act only on the press edge
                        // (released -> pressed); a second tap within the window
                        // summons. We read one modifier bit, not key content.
                        let rcmd = event.get_flags().bits() & RCMD_BIT != 0;
                        if rcmd && !g.right_cmd_down {
                            let now = Instant::now();
                            let is_double = g
                                .last_right_cmd
                                .map(|t| now.duration_since(t) < Duration::from_millis(DOUBLE_RCMD_MS as u64))
                                .unwrap_or(false);
                            if is_double {
                                g.last_right_cmd = None; // reset so a triple isn't two doubles
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || toggle_window(&handle));
                            } else {
                                g.last_right_cmd = Some(now);
                            }
                        }
                        g.right_cmd_down = rcmd;
                    }
                    CGEventType::KeyDown => {
                        let flags = event.get_flags().bits();
                        let keycode = event
                            .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        // Right-⌘ + Right-⇧ + V (keycode 9): grab the current
                        // selection from the focused app and send it to the
                        // active instant session. Right-side device bits isolate
                        // this from the plain Cmd+V capture below. Drop the event
                        // so the focused app doesn't also paste.
                        if keycode == 9 && flags & RCMD_BIT != 0 && flags & RSHIFT_BIT != 0 {
                            let handle = app.clone();
                            std::thread::spawn(move || grab_and_send_selection(&handle));
                            return CallbackResult::Drop;
                        }
                        if event.get_flags().contains(CGEventFlags::CGEventFlagCommand) {
                            // 8 = C, 9 = V (ANSI keycodes). Only these two — not a keylogger.
                            match keycode {
                                8 => maybe_capture(&mut g, &app, &enabled, "copy"),
                                9 => maybe_capture(&mut g, &app, &enabled, "paste"),
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                CallbackResult::Keep // passive: pass every event through unchanged
            },
            move || {
                // Tap created OK; mark it live for the capture diagnostics, then
                // run its runloop (blocks this thread for the app's lifetime).
                ta.store(true, Ordering::Relaxed);
                CFRunLoop::run_current()
            },
        );
        if res.is_err() {
            tap_active.store(false, Ordering::Relaxed);
            eprintln!(
                "input taps disabled: event tap creation failed \
                 (grant Accessibility / Input Monitoring permission)"
            );
        }
    });
}

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
    let Some(tray) = app.tray_by_id("main") else { return };
    if on {
        let _ = tray.set_icon(Some(dot_icon([220, 40, 40])));
    } else {
        let _ = tray.set_icon(app.default_window_icon().cloned());
    }
    let _ = tray.set_icon_as_template(false); // keep the red colored, not monochrome
}

/// Synthesize a ⌘C keystroke so the focused app copies its current selection to
/// the pasteboard. Plain (left) Command flag, so it doesn't re-trigger the
/// right-side send-highlight combo in our own tap.
fn synth_copy() {
    let Ok(src) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else { return };
    const KC_C: u16 = 8;
    if let Ok(ev) = CGEvent::new_keyboard_event(src.clone(), KC_C, true) {
        ev.set_flags(CGEventFlags::CGEventFlagCommand);
        ev.post(CGEventTapLocation::HID);
    }
    if let Ok(ev) = CGEvent::new_keyboard_event(src, KC_C, false) {
        ev.set_flags(CGEventFlags::CGEventFlagCommand);
        ev.post(CGEventTapLocation::HID);
    }
}

fn read_clipboard() -> String {
    std::process::Command::new("pbpaste")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Copy the focused app's selection, then hand the text to the webview, which
/// writes it into the active session. Runs off the tap thread (it sleeps for the
/// copy to land). Overwrites the pasteboard, same as a manual ⌘C.
fn grab_and_send_selection(app: &AppHandle) {
    synth_copy();
    std::thread::sleep(Duration::from_millis(120)); // let the copy reach the pasteboard
    let text = read_clipboard();
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("send-highlight-text", text);
    }
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

/// Toggle the summon window. When showing, anchor it to the mouse cursor.
fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };

    if win.is_visible().unwrap_or(false) {
        let _ = win.hide(); // focus-lost handler demotes us out of the switcher
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
    let _ = win.show();
    let _ = win.set_focus();
    // Tell the front to play its entrance animation + refocus the active term.
    let _ = win.emit("summoned", ());
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
    let Some(name) = PREV_APP.lock().unwrap().take() else { return };
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
    Ok(if p.is_absolute() { p } else { PathBuf::from(cwd).join(p) })
}

/// Open a path or URL the user ⌘-clicked in a terminal, iTerm2-style. URLs go to
/// the default browser; existing paths open in their default app (Finder for a
/// dir) via Launch Services. Relative paths + `~` resolve against the pane cwd;
/// a trailing `:line[:col]` is stripped before the existence check. Hides the
/// summon window so the opened app comes forward. Returns "url" | "path" for the
/// front to log, or Err when nothing resolved (the caller ignores it silently).
#[tauri::command]
fn open_target(app: AppHandle, target: String, cwd: String) -> Result<String, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("empty".into());
    }
    // URL: a bare www. host, or an explicit scheme://… with an alnum+[-+.] scheme.
    let scheme_ok = t.split_once("://").is_some_and(|(s, _)| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
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
fn run_click(command: String, cwd: String) -> Result<String, String> {
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

/// Append one line to app_data_dir/instant.log. The webview has no console a user
/// can reach, so errors/events are mirrored here. Best-effort: logging never
/// throws back into the app. Caps the file so it can't grow unbounded.
#[tauri::command]
fn log_append(app: AppHandle, line: String) {
    let Ok(path) = log_file_path(&app) else { return };
    // Trim from the front if it crosses the cap (cheap: rewrite tail on overflow).
    const CAP: u64 = 2_000_000;
    if std::fs::metadata(&path).map(|m| m.len() > CAP).unwrap_or(false) {
        if let Ok(data) = std::fs::read(&path) {
            let keep = data.len().saturating_sub(CAP as usize / 2);
            let _ = std::fs::write(&path, &data[keep..]);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
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
fn log_reveal(app: AppHandle) -> Result<(), String> {
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
fn screenshot() -> Result<String, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cmd+Alt+Space
    let summon = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);
    // Opt out of the process-wide singletons (tray icon, global Cmd+Alt+Space
    // shortcut, and the double-right-click/double-right-⌘ summon gesture's
    // CGEventTap) so a second instance — launched for dev/verification — doesn't
    // fight the owner's always-running one over the same OS-level resources.
    let no_globals = std::env::var("INSTANT_NO_GLOBALS").is_ok();

    tauri::Builder::default()
        .manage(pty::PtyStore::default())
        .manage(cdp::CdpStore::default())
        .manage(cdp::ChromeEngine::default())
        .manage(workspace::Workspaces::default())
        .manage(favorites::Favorites::default())
        .plugin(tauri_plugin_opener::init())
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
            if !no_globals {
                app.global_shortcut().register(summon)?;
            }

            // Capture flag, shared with the tap thread. Default OFF; the front
            // re-enables it on boot if the user had recording on.
            let enabled = Arc::new(AtomicBool::new(false));
            app.manage(activity::CaptureEnabled(enabled.clone()));
            let tap_active = Arc::new(AtomicBool::new(false));
            app.manage(capture::TapActive(tap_active.clone()));
            if no_globals {
                eprintln!(
                    "INSTANT_NO_GLOBALS set: skipping tray icon, global shortcut, and \
                     the double-click/double-cmd summon gesture (so this instance doesn't \
                     fight the owner's live one) — showing the main window on launch instead"
                );
            } else {
                spawn_input_taps(app.handle().clone(), enabled, tap_active);
            }

            // Track focus on our own window so the capture worker can skip
            // gestures made inside instant (clicking rows/chips shouldn't record).
            let focused = Arc::new(AtomicBool::new(false));
            app.manage(capture::WindowFocused(focused.clone()));
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

            // Hydrate the workspace registry from disk.
            let loaded = workspace::load(app.handle());
            *app.state::<workspace::Workspaces>().0.lock().unwrap() = loaded;

            // Open (create) the favorited-AI-turns db.
            favorites::init(app.handle());

            // Unified activity store + localhost ingest endpoint for the extension.
            // state_dir keeps dev and a prod build on separate dbs/config.
            let data_dir = state_dir(app.handle())?;
            let conn = activity::open(&data_dir.join("activity.db"))?;
            app.manage(activity::ActivityDb(Mutex::new(conn)));

            // Observation filters (config.json, created with empty lists if absent).
            let cfg_path = data_dir.join("config.json");
            let (cfg, status) = config::read_or_default(&cfg_path);
            app.manage(config::ConfigState {
                config: Mutex::new(cfg),
                path: cfg_path,
                status: Mutex::new(status),
                excluded_count: std::sync::atomic::AtomicU64::new(0),
            });

            // Config-driven extension rules (rules.json, created empty if absent).
            // Served at GET /config; edited via the Rules panel.
            let rules_path = data_dir.join("rules.json");
            let rules = activity::read_rules(&rules_path);
            app.manage(activity::RulesState {
                rules: Mutex::new(rules),
                path: rules_path,
            });

            activity::spawn_server(app.handle().clone());
            pty::reap_orphan_graphics(); // clean awrit orphans from a prior crash/restart
            cdp::reap_orphans(); // clean headless-Chrome orphans from a prior SIGTERM

            // Menu-bar accessory app: no Dock tile, no Cmd-Tab entry.
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if no_globals {
                // No tray, no shortcut, no summon gesture to show the window with —
                // so show it directly instead of leaving the instance unreachable.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
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
            pty::open_session,
            pty::write_pty,
            pty::resize_pty,
            pty::close_pty,
            pty::kill_session,
            pty::scroll_session,
            pty::rogue_agent_sessions,
            cdp::cdp_open,
            cdp::cdp_send,
            cdp::cdp_resize,
            cdp::cdp_navigate,
            cdp::cdp_close,
            cdp::cdp_status,
            workspace::list_workspaces,
            workspace::create_workspace,
            workspace::remove_workspace,
            worktrees::scan_worktrees,
            worktrees::add_worktree,
            worktrees::git_diff,
            worktrees::remove_worktree,
            worktrees::worktree_at,
            activity::activity_events,
            activity::activity_clear,
            activity::activity_log,
            activity::capture_set_enabled,
            activity::capture_enabled,
            activity::rules_get,
            activity::rules_set,
            capture::capture_permissions,
            capture::capture_request_screen,
            config::config_get,
            config::config_set,
            config::config_reload,
            config::config_open,
            fs::list_dir,
            fs::list_dir_meme,
            fs::list_dir_recursive,
            fs::read_image,
            fs::read_text,
            harness::harness_session,
            harness::harness_sessions,
            ledger::list_ai_sessions,
            ledger::read_ai_messages,
            ledger::latest_ai_message,
            meme::make_slack_emoji,
            meme::magick_available,
            meme::install_imagemagick,
            meme::save_meme,
            meme::copy_meme_image,
            favorites::fav_add,
            favorites::fav_remove,
            favorites::fav_list,
            sprefa_plugin::commands::sprefa_schema,
            sprefa_plugin::commands::sprefa_ping,
            sprefa_plugin::commands::sprefa_eval,
            sprefa_plugin::commands::sprefa_query_sql,
            sprefa_plugin::commands::sprefa_rel_source,
            screenshot,
            open_target,
            run_click,
            log_append,
            log_path,
            log_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tear down the shared headless Chrome when the app exits so it
            // doesn't linger holding its profile/port.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                cdp::kill_engine(app);
            }
        });
}
