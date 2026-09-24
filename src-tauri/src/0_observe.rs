// `<state_dir>/instant.log` is read by `just log`, the e2e suites and the
// `log_path`/`log_reveal` commands; the file name is fixed.

use std::path::Path;
use std::sync::{Arc, Mutex};

use hafley_observe::{Config, Sink};
use tracing_subscriber::fmt::writer::{BoxMakeWriter, MakeWriterExt};

/// The file every event is appended to, beside the rest of a build's state.
pub const LOG_FILE: &str = "instant.log";

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
    let path = state_dir.join(LOG_FILE);
    let writer = match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => BoxMakeWriter::new(std::io::stderr.and(Mutex::new(file))),
        Err(error) => {
            eprintln!("observe: cannot open {}: {error}", path.display());
            BoxMakeWriter::new(std::io::stderr)
        }
    };
    if let Err(error) = hafley_observe::init_with_sinks(config, writer, sinks) {
        eprintln!("observe init: {error}");
    }
}
