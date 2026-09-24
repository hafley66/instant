// ServeHost: the Host for the instant-serve binary. Emits go to a broadcast
// channel drained by every subscribed WebSocket connection; no window, no tray.

use std::path::PathBuf;
use std::sync::Arc;

use hafley_observe::{Row, Sink};

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

    /// `host::state_dir` for callers outside the crate (the serve bin).
    pub fn state_dir(&self) -> Result<PathBuf, String> {
        crate::host::state_dir(self)
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
        tracing::info!(on, "recording_indicator");
    }
}

/// Env var that turns on `LogSink` in instant-serve.
pub const LOG_STREAM_VARIABLE: &str = "INSTANT_SERVE_LOG_STREAM";

/// Every tracing row, re-emitted as a `log` event to subscribed /ws clients.
pub struct LogSink(pub Arc<ServeHost>);

impl Sink for LogSink {
    fn label(&self) -> &'static str {
        "serve-ws"
    }

    fn write(&self, rows: &[Row]) {
        for row in rows {
            let fields: serde_json::Map<String, serde_json::Value> = row
                .fields
                .iter()
                .map(|(name, value)| (name.clone(), serde_json::Value::String(value.clone())))
                .collect();
            let _ = self.0.emit(
                "log",
                serde_json::json!({
                    "ts_ns": row.ts_ns,
                    "level": row.level,
                    "name": row.name,
                    "target": row.target,
                    "file": row.file,
                    "line": row.line,
                    "fields": fields,
                }),
            );
        }
    }
}
