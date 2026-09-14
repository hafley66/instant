// Backend-owned loopback service for generated rustdoc trees. Chrome cannot
// load rustdoc from file:// (its search index is fetch()ed), and the native
// shell has no HTTP origin of its own, so a selected doc root is served from a
// private 127.0.0.1 server on an ephemeral port. One server per canonical root,
// reused while the root stays registered, shut down with its owner. The serve
// binary registers its --doc-root here too, so both backends answer the same
// `rustdoc_open` command and the frontend never derives a URL from its origin.
//
// Registration happens only from an explicit selection: a file the user opened
// that resolves to a rustdoc root, or the operator's --doc-root. Nothing walks
// the filesystem to discover roots.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::serve::rustdoc;

/// How long register waits for the spawned server thread to report that its
/// runtime came up and the listener was adopted. A failure to start must not
/// look like success.
const START_TIMEOUT: Duration = Duration::from_secs(10);

struct Server {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Inner {
    servers: HashMap<PathBuf, Server>,
    last: Option<PathBuf>,
}

/// Owns every loopback doc server the process started. Cheap to clone by
/// reference through `Services`; the servers live until stop_all.
#[derive(Default)]
pub struct DocService(Mutex<Inner>);

impl DocService {
    /// Serve `root` on 127.0.0.1 and return its port. A root already registered
    /// keeps its server and port, so repeated opens reuse one origin. The call
    /// does not return success until the server thread has built its runtime and
    /// adopted the listener, so a failed startup is an error and nothing dead is
    /// cached.
    pub fn register(&self, root: &Path) -> Result<u16, String> {
        let canon = rustdoc::canonical_root(root)?;
        {
            let mut inner = self.0.lock().unwrap();
            if let Some(server) = inner.servers.get(&canon) {
                let port = server.port;
                inner.last = Some(canon);
                return Ok(port);
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("cannot bind doc server: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("cannot configure doc server: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("cannot read doc server addr: {e}"))?
            .port();
        let (shutdown, stop) = oneshot::channel::<()>();
        let app = rustdoc::doc_router(Some(canon.clone()));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        std::thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("cannot start doc server runtime: {e}")));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("cannot adopt doc server listener: {e}")));
                        return;
                    }
                };
                // Only now is the socket accepting; anything earlier must be an
                // error, not a cached port pointing at nothing.
                let _ = ready_tx.send(Ok(()));
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = stop.await;
                    })
                    .await;
            });
        });
        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("doc server did not become ready".into()),
        }
        let port = {
            let mut inner = self.0.lock().unwrap();
            match inner.servers.entry(canon.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.get().port,
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Server {
                        port,
                        shutdown: Some(shutdown),
                    });
                    port
                }
            }
        };
        self.0.lock().unwrap().last = Some(canon);
        Ok(port)
    }

    /// The URL of the most recently registered root, for the palette command.
    fn last_url(&self) -> Option<String> {
        let inner = self.0.lock().unwrap();
        let root = inner.last.as_ref()?;
        let port = inner.servers.get(root)?.port;
        Some(format!("http://127.0.0.1:{port}/"))
    }

    /// Gracefully stop every server (app exit). Dropping the shutdown sender
    /// would also end each server; sending lets the accept loop finish.
    pub fn stop_all(&self) {
        let mut inner = self.0.lock().unwrap();
        for (_, server) in inner.servers.drain() {
            if let Some(shutdown) = server.shutdown {
                let _ = shutdown.send(());
            }
        }
        inner.last = None;
    }
}

/// Dropping the owner releases every listener, so a service that goes out of
/// scope with the process still cleans up its sockets.
impl Drop for DocService {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Map a locally selected page to a URL on its rustdoc root's loopback server.
/// `Ok(None)` means the path is not a rustdoc page and the normal file-open
/// path should continue; `Err` means it looks generated but is missing, or the
/// file cannot be read.
pub fn open_impl(service: &DocService, path: Option<&Path>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return service
            .last_url()
            .map(Some)
            .ok_or_else(no_root_message);
    };
    // An unreadable or absent path is not claimed; the normal file-open path
    // still runs and reports its own error. A target/doc-shaped path gets the
    // "generate docs first" message instead.
    if let Ok(canon) = std::fs::canonicalize(path) {
        if let Some(root) = rustdoc::find_root(&canon) {
            let rel = rustdoc::relative_path(&root, &canon)
                .ok_or_else(|| "selected file is outside its documentation root".to_string())?;
            let port = service.register(&root)?;
            return Ok(Some(format!(
                "http://127.0.0.1:{port}/{}",
                rustdoc::percent_encode_path(&rel)
            )));
        }
    }
    if rustdoc::looks_generated(path) {
        return Err(format!(
            "no generated documentation at {}; run `cargo doc` in the crate first",
            path.display()
        ));
    }
    Ok(None)
}

fn no_root_message() -> String {
    "no documentation root open; open a generated target/doc/<crate>/index.html \
     (⌘-click it, or jump to it), or start instant-serve with --doc-root"
        .to_string()
}

/// The `rustdoc_open` command, shared by the Tauri and instant-serve backends.
/// With a path it maps a selected page; with none it opens the last registered
/// root (the palette entry point).
#[tauri::command]
pub fn rustdoc_open(
    services: tauri::State<'_, Arc<crate::services::Services>>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    open_impl(&services.doc_service, path.as_deref().map(Path::new))
}
