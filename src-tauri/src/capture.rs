// Event-driven screen capture. The CGEventTap (lib.rs) calls `take` on its own
// ephemeral thread for each throttled gesture (click / dblclick / drag-edge /
// copy / paste). One full-screen PNG via `screencapture -x`, tagged with the
// frontmost app, inserted into the unified activity store, then `activity-added`
// so the timeline updates live.
//
// Needs Screen Recording permission (granted once, on the first shot). Capture
// is OFF by default and gated by the CaptureEnabled flag checked before we get
// here, so this only runs when the user has opted in.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::activity::{self, ActivityDb};

/// Whether the instant window is focused, kept current by the window focus
/// event (lib.rs). The capture worker reads it to avoid screenshotting our own
/// UI while you click around inside the app.
pub struct WindowFocused(pub Arc<AtomicBool>);

/// Take one shot for `kind`, store it, emit the row. Best-effort: any failure
/// (no permission, dir error, screencapture nonzero) silently no-ops.
pub fn take(app: AppHandle, kind: &str) {
    let ts = activity::now_ms();

    // Don't record our own clicks: skip while the instant window is focused.
    // Not counted as a filter — interacting with the app just isn't an event.
    if app.state::<WindowFocused>().0.load(Ordering::Relaxed) {
        return;
    }

    // Observation filter: never even screenshot while an excluded app is front.
    let app_name = frontmost_app();
    {
        let cfg = app.state::<crate::config::ConfigState>();
        if cfg.config.lock().unwrap().app_excluded(&app_name) {
            crate::config::note_excluded(&cfg);
            return;
        }
    }

    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let dir = data_dir.join("captures").join(day_string(ts));
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let shot = dir.join(format!("{ts}-{kind}.png"));

    // Absolute path: GUI apps don't get /usr/sbin in PATH. -x silent, no shutter
    // sound; full main display.
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png"])
        .arg(&shot)
        .status();
    if status.map(|s| !s.success()).unwrap_or(true) || !shot.exists() {
        return;
    }

    let shot_str = shot.to_string_lossy().into_owned();
    let db = app.state::<ActivityDb>();
    let row = {
        let conn = db.0.lock().unwrap();
        activity::insert_row(&conn, ts, "os", kind, &app_name, "", "", "", &shot_str)
    };
    if let Ok(ev) = row {
        let _ = app.emit("activity-added", &ev);
    }
}

/// Frontmost app name via CGWindowList. The on-screen window list is ordered
/// front-to-back, so the first window at layer 0 (the normal app layer) is the
/// frontmost app; we return its owner name. Pure Core Graphics — no extra TCC
/// prompt beyond the Screen Recording we already need for the shot. (lsappinfo's
/// ASN lookup returns empty on current macOS, so we don't shell out.)
fn frontmost_app() -> String {
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let Some(info) = copy_window_info(opts, kCGNullWindowID) else {
        return String::new();
    };
    let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) };
    let name_key = unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerName) };
    for i in 0..info.len() {
        let Some(item) = info.get(i) else { continue };
        let dict =
            unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as _) };
        // Skip menubar/dock/overlay windows (non-zero layer).
        let layer = dict
            .find(&layer_key)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .unwrap_or(-1);
        if layer != 0 {
            continue;
        }
        if let Some(name) = dict.find(&name_key).and_then(|v| v.downcast::<CFString>()) {
            let s = name.to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    String::new()
}

// UTC date bucket for the capture folder. Howard Hinnant's civil-from-days, so
// no chrono dependency just to name a directory.
fn day_string(ts_ms: i64) -> String {
    let (y, m, d) = civil_from_days(ts_ms.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}
