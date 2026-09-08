// TCC probes and the frontmost-app lookup shared by the shell (window summon,
// frontmost watch) and the Activity panel. The CGEventTap is gone.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName,
};
use serde::Serialize;
use tauri::State;

use crate::services::Services;

// macOS TCC probes (ApplicationServices umbrella: AXIsProcessTrusted lives there).
// CGPreflight = already held, CGRequest = prompt, AX = Accessibility.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn AXIsProcessTrusted() -> bool;
}

/// Whether the instant window is focused, kept current by the window focus
/// event (lib.rs).
pub struct WindowFocused(pub Arc<AtomicBool>);

/// TCC state for the Activity panel's capture diagnostics.
#[derive(Serialize)]
pub struct CapturePerms {
    pub screen_recording: bool,
    pub accessibility: bool,
    pub tap_active: bool,
    pub tap_expected: bool,
}

#[tauri::command]
pub fn capture_permissions(services: State<Arc<Services>>) -> CapturePerms {
    capture_permissions_impl(&services)
}

pub fn capture_permissions_impl(_services: &Services) -> CapturePerms {
    CapturePerms {
        screen_recording: unsafe { CGPreflightScreenCaptureAccess() },
        accessibility: unsafe { AXIsProcessTrusted() },
        // The CGEventTap is gone; the tap fields stay false for the old shape.
        tap_active: false,
        tap_expected: false,
    }
}

/// Trigger the macOS Screen Recording prompt (adds instant to the list). The
/// grant only takes effect for screencapture after this returns true; the OS
/// may still require a relaunch for some flows.
#[tauri::command]
pub fn capture_request_screen() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// Frontmost app name via CGWindowList. The on-screen window list is ordered
/// front-to-back, so the first window at layer 0 (the normal app layer) is the
/// frontmost app; we return its owner name. Pure Core Graphics — no extra TCC
/// prompt beyond the Screen Recording we already need for the shot. (lsappinfo's
/// ASN lookup returns empty on current macOS, so we don't shell out.)
pub(crate) fn frontmost_app() -> String {
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let Some(info) = copy_window_info(opts, kCGNullWindowID) else {
        return String::new();
    };
    let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) };
    let name_key = unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerName) };
    for i in 0..info.len() {
        let Some(item) = info.get(i) else { continue };
        let dict = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as _) };
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
