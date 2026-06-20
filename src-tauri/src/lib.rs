mod pty;

use std::sync::Mutex;
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
const DOUBLE_RIGHT_MS: u128 = 350;

/// Listen for a global double-right-click on a dedicated thread running its own
/// CFRunLoop. The tap subscribes to RightMouseDown only — listening to keyboard
/// events here would crash, since rdev/TIS keycode translation must run on the
/// main thread. Listen-only, so it never swallows the click and context menus
/// still work. Needs Accessibility / Input Monitoring permission, same as the hotkey.
fn spawn_right_click_gesture(app: AppHandle) {
    std::thread::spawn(move || {
        let last = Mutex::new(None::<Instant>);
        let res = CGEventTap::with_enabled(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::RightMouseDown],
            |_proxy, _ty, _event| {
                let now = Instant::now();
                let mut last = last.lock().unwrap();
                let is_double = last
                    .map(|t| now.duration_since(t) < Duration::from_millis(DOUBLE_RIGHT_MS as u64))
                    .unwrap_or(false);
                if is_double {
                    *last = None; // reset so a triple-click isn't two doubles
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || toggle_window(&handle));
                } else {
                    *last = Some(now);
                }
                CallbackResult::Keep // passive: pass the click through unchanged
            },
            || CFRunLoop::run_current(),
        );
        if res.is_err() {
            eprintln!(
                "right-click gesture disabled: event tap creation failed \
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
            spawn_right_click_gesture(app.handle().clone());

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
            screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
