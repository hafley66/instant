mod activity;
mod capture;
mod config;
mod fs;
mod pty;
mod workspace;
mod worktrees;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_foundation::runloop::CFRunLoop;
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};
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
// Global throttle between screen captures, across all gesture kinds.
const MIN_GAP: Duration = Duration::from_millis(350);

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
fn spawn_input_taps(app: AppHandle, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let g = Mutex::new(Gesture::default());
        let res = CGEventTap::with_enabled(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
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
                        if event.get_flags().contains(CGEventFlags::CGEventFlagCommand) {
                            // 8 = C, 9 = V (ANSI keycodes). Only these two — not a keylogger.
                            match event
                                .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                            {
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
            || CFRunLoop::run_current(),
        );
        if res.is_err() {
            eprintln!(
                "input taps disabled: event tap creation failed \
                 (grant Accessibility / Input Monitoring permission)"
            );
        }
    });
}

/// Toggle the summon window. When showing, anchor it to the mouse cursor.
fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };

    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }

    if let Mouse::Position { x, y } = Mouse::get_mouse_position() {
        position_at_cursor(&win, x as f64, y as f64);
    }

    let _ = win.show();
    let _ = win.set_focus();
    // Tell the front to play its entrance animation + refocus the active term.
    let _ = win.emit("summoned", ());
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

    tauri::Builder::default()
        .manage(pty::PtyStore::default())
        .manage(workspace::Workspaces::default())
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
            app.global_shortcut().register(summon)?;

            // Capture flag, shared with the tap thread. Default OFF; the front
            // re-enables it on boot if the user had recording on.
            let enabled = Arc::new(AtomicBool::new(false));
            app.manage(activity::CaptureEnabled(enabled.clone()));
            spawn_input_taps(app.handle().clone(), enabled);

            // Track focus on our own window so the capture worker can skip
            // gestures made inside instant (clicking rows/chips shouldn't record).
            let focused = Arc::new(AtomicBool::new(false));
            app.manage(capture::WindowFocused(focused.clone()));
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::Focused(f) = e {
                        focused.store(*f, Ordering::Relaxed);
                    }
                });
            }

            // Hydrate the workspace registry from disk.
            let loaded = workspace::load(app.handle());
            *app.state::<workspace::Workspaces>().0.lock().unwrap() = loaded;

            // Unified activity store + localhost ingest endpoint for the extension.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
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

            activity::spawn_server(app.handle().clone());

            // Menu-bar accessory app: no Dock tile, no Cmd-Tab entry.
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let toggle_i = MenuItem::with_id(app, "toggle", "Summon / Hide", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
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
            workspace::list_workspaces,
            workspace::create_workspace,
            workspace::remove_workspace,
            worktrees::scan_worktrees,
            activity::activity_events,
            activity::activity_clear,
            activity::activity_log,
            activity::capture_set_enabled,
            activity::capture_enabled,
            config::config_get,
            config::config_set,
            config::config_reload,
            config::config_open,
            fs::list_dir,
            fs::read_image,
            fs::read_text,
            screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
