// Host: the surface commands and background threads reach Tauri through. One
// implementation (TauriHost) wraps an AppHandle; a second (ServeHost, in the
// serve binary) will serve the same command table over loopback WebSocket with
// no Tauri in the process. Commands and threads take &dyn Host or Arc<dyn Host>,
// never AppHandle.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub trait Host: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;
    // Reserved for the serve-bin lane: no owned command reaches a window yet,
    // but the contract (plans/tauri-condom.md section 3) declares it.
    #[allow(dead_code)]
    fn window(&self, label: &str) -> Option<Box<dyn HostWindow>>;
    fn app_data_dir(&self) -> Result<PathBuf, String>;
    fn debug_build(&self) -> bool;
    fn set_recording_indicator(&self, on: bool);
}

#[allow(dead_code)]
pub trait HostWindow {
    fn show(&self) -> Result<(), String>;
    fn hide(&self) -> Result<(), String>;
    fn set_focus(&self) -> Result<(), String>;
    fn inner_size(&self) -> Result<(u32, u32), String>;
    fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String>;
}

#[derive(Clone)]
pub struct TauriHost(pub AppHandle);

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        self.0.emit(event, payload).map_err(|e| e.to_string())
    }

    fn window(&self, label: &str) -> Option<Box<dyn HostWindow>> {
        self.0
            .get_webview_window(label)
            .map(|w| Box::new(TauriWindow(w)) as Box<dyn HostWindow>)
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        self.0.path().app_data_dir().map_err(|e| e.to_string())
    }

    fn debug_build(&self) -> bool {
        cfg!(debug_assertions)
    }

    fn set_recording_indicator(&self, on: bool) {
        crate::set_recording_indicator(&self.0, on);
    }
}

#[allow(dead_code)]
struct TauriWindow(WebviewWindow);

impl HostWindow for TauriWindow {
    fn show(&self) -> Result<(), String> {
        self.0.show().map_err(|e| e.to_string())
    }
    fn hide(&self) -> Result<(), String> {
        self.0.hide().map_err(|e| e.to_string())
    }
    fn set_focus(&self) -> Result<(), String> {
        self.0.set_focus().map_err(|e| e.to_string())
    }
    fn inner_size(&self) -> Result<(u32, u32), String> {
        self.0
            .inner_size()
            .map(|s| (s.width, s.height))
            .map_err(|e| e.to_string())
    }
    fn set_ignore_cursor_events(&self, ignore: bool) -> Result<(), String> {
        self.0
            .set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())
    }
}

/// Per-build state directory, keyed off the host's app data dir. A release
/// build nests its state under `prod` so it can run beside a dev instance.
pub fn state_dir(host: &dyn Host) -> Result<PathBuf, String> {
    let mut dir = host.app_data_dir()?;
    if !host.debug_build() {
        dir.push("prod");
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Serialize append/truncate cycles for host-driven logging (commands that hold
// only a &dyn Host, e.g. resolve_ref) so concurrent writers cannot reorder
// bytes or truncate a newer write.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append one structured line to app_data_dir/instant.log, mirroring lib.rs's
/// event log for commands that no longer hold an AppHandle. Best-effort: a
/// logging failure never throws back into the caller.
pub fn log_event(host: &dyn Host, level: &str, event: &str, fields: serde_json::Value) {
    let line = format!(
        "ts={} level={} target=instant event={} fields={}",
        log_timestamp_ms(),
        level,
        event,
        serde_json::to_string(&fields).unwrap_or_else(|_| "{}".to_string()),
    );
    let Ok(dir) = state_dir(host) else { return };
    let path = dir.join("instant.log");
    let _guard = LOG_LOCK.lock().unwrap();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::favorites::fav_add_impl;
    use crate::services::Services;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Arc;

    // A recording Host: emit pushes (event, payload) into a Vec; everything
    // else is a no-op that the command under test never reaches.
    #[derive(Default)]
    struct FakeHost {
        emits: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl FakeHost {
        fn takes(&self) -> Vec<(String, serde_json::Value)> {
            self.emits.lock().unwrap().clone()
        }
    }

    impl Host for FakeHost {
        fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
            self.emits.lock().unwrap().push((event.to_string(), payload));
            Ok(())
        }
        fn window(&self, _label: &str) -> Option<Box<dyn HostWindow>> {
            None
        }
        fn app_data_dir(&self) -> Result<PathBuf, String> {
            Ok(PathBuf::from("/tmp/fake-host"))
        }
        fn debug_build(&self) -> bool {
            true
        }
        fn set_recording_indicator(&self, _on: bool) {}
    }

    fn test_services() -> Services {
        let favorites = {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute_batch(crate::favorites::SCHEMA).unwrap();
            crate::favorites::Favorites(Mutex::new(Some(conn)))
        };
        Services {
            pty: Default::default(),
            pty_events: Default::default(),
            cdp: Default::default(),
            chrome_engine: Default::default(),
            workspaces: Default::default(),
            favorites,
            fs_watch: Default::default(),
            capture_enabled: crate::activity::CaptureEnabled(Arc::new(AtomicBool::new(false))),
            tap_active: crate::capture::TapActive(Arc::new(AtomicBool::new(false))),
            window_focused: crate::capture::WindowFocused(Arc::new(AtomicBool::new(false))),
            activity: crate::activity::ActivityDb(Mutex::new(
                rusqlite::Connection::open_in_memory().unwrap(),
            )),
            config: crate::config::ConfigState {
                config: Mutex::new(Default::default()),
                path: PathBuf::new(),
                status: Mutex::new(crate::config::ConfigStatus {
                    source: "default".into(),
                    error: None,
                }),
                excluded_count: AtomicU64::new(0),
            },
            rules: crate::activity::RulesState {
                rules: Mutex::new(Vec::new()),
                path: PathBuf::new(),
                revision: AtomicU64::new(1),
            },
            watcher: crate::activity::WatcherState(Mutex::new(Default::default())),
        }
    }

    #[test]
    fn fav_add_emits_the_fresh_snapshot() {
        let host = FakeHost::default();
        let services = test_services();
        let msg = boop_harness::transcript::Message {
            harness: boop_harness::HarnessId::Claude,
            session_id: "sess-1".into(),
            id: "msg-1".into(),
            seq: 1,
            role: "assistant".into(),
            subtype: None,
            ts: 1,
            preview: "preview".into(),
            text: "text".into(),
            locator: "claude:x#L1".into(),
        };
        let snapshots = fav_add_impl(&host, &services, msg, "/work".to_string()).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].editor, "claude");
        assert_eq!(snapshots[0].session_id, "sess-1");
        assert_eq!(snapshots[0].message_id, "msg-1");

        let takes = host.takes();
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0].0, "favorites-changed");
        let payload = &takes[0].1;
        assert_eq!(payload.as_array().map(Vec::len), Some(1));
        assert_eq!(payload[0]["editor"], "claude");
        assert_eq!(payload[0]["session_id"], "sess-1");
        assert_eq!(payload[0]["message_id"], "msg-1");
    }
}
