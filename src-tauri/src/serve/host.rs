// ServeHost: the Host for the instant-serve binary. Emits go to a broadcast
// channel drained by every subscribed WebSocket connection; no window, no tray.

use std::path::PathBuf;

use tokio::sync::broadcast;

use crate::host::{Host, HostWindow};

pub struct ServeHost {
    events: broadcast::Sender<(String, serde_json::Value)>,
    data_dir: PathBuf,
}

impl ServeHost {
    pub fn new(data_dir: PathBuf) -> ServeHost {
        let (events, _) = broadcast::channel(1024);
        ServeHost { events, data_dir }
    }

    /// One receiver per WebSocket connection that sent the `events` frame.
    pub fn subscribe(&self) -> broadcast::Receiver<(String, serde_json::Value)> {
        self.events.subscribe()
    }
}

impl Host for ServeHost {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        // No subscriber yet means the event is dropped, not an error: the
        // frontend subscribes per connection and re-requests on reconnect.
        let _ = self.events.send((event.to_string(), payload));
        Ok(())
    }

    fn window(&self, _label: &str) -> Option<Box<dyn HostWindow>> {
        None
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.data_dir.clone())
    }

    fn debug_build(&self) -> bool {
        cfg!(debug_assertions)
    }

    fn set_recording_indicator(&self, on: bool) {
        crate::host::log_event(
            self,
            "INFO",
            "recording_indicator",
            serde_json::json!({ "on": on }),
        );
    }
}
