// `<state_dir>/instant.log` is read by `just log`, the e2e suites and the
// `log_path`/`log_reveal` commands; the file name is fixed.

use std::path::Path;
use std::sync::{Arc, Mutex};

use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use hafley_observe::{Config, Sink};
use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};

/// The file every event is appended to, beside the rest of a build's state.
pub const LOG_FILE: &str = "instant.log";

/// `instant.log` rolls to `instant.log.1..=3` at this size.
const LOG_BYTES: usize = 2 * 1024 * 1024;
const LOG_KEEP: usize = 3;

/// Filter used when neither RUST_LOG nor HAFLEY_LOG is set.
pub const DEFAULT_FILTER: &str = "info";

/// A failed install is reported on stderr; logging never stops the app.
pub fn init(service_name: &'static str, state_dir: &Path, sinks: Vec<Arc<dyn Sink>>) {
    let config = match Config::from_env(service_name, env!("CARGO_PKG_VERSION"), DEFAULT_FILTER, false) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("observe config: {error}");
            return;
        }
    };
    let file = FileRotate::new(
        state_dir.join(LOG_FILE),
        AppendCount::new(LOG_KEEP),
        ContentLimit::BytesSurpassed(LOG_BYTES),
        Compression::None,
        None,
    );
    let writer = BoxMakeWriter::new(std::io::stderr.and(Mutex::new(file)));
    if let Err(error) = hafley_observe::init_with_sinks(config, writer, sinks) {
        eprintln!("observe init: {error}");
    }
}
