// instant-serve: the whole backend with no Tauri in the process. Serves the
// built frontend over HTTP and the command table over a JSON-RPC 2.0 WebSocket.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;

use hafley_observe::Sink;
use instant_lib::serve::{router, LogSink, ServeHost, ServeState, Services, LOG_STREAM_VARIABLE};

#[derive(Parser)]
#[command(about = "instant backend over HTTP + a JSON-RPC WebSocket, no Tauri")]
struct Args {
    /// TCP port to listen on (0 picks a free port)
    #[arg(long, default_value_t = 47777)]
    port: u16,
    /// App data dir (defaults to the Tauri app's app_data_dir)
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Directory holding the built frontend (defaults to ../dist beside this binary)
    #[arg(long)]
    dist: Option<PathBuf>,
    /// Generated cargo doc tree to serve read-only at /rustdoc/ (default: off)
    #[arg(long)]
    doc_root: Option<PathBuf>,
}

fn default_data_dir() -> PathBuf {
    // The same base tauri's app_data_dir uses on macOS for com.instant.summon;
    // release builds nest under prod/ via host::state_dir, matching the app.
    let home = std::env::var_os("HOME").expect("HOME set");
    PathBuf::from(home).join("Library/Application Support/com.instant.summon")
}

fn default_dist() -> PathBuf {
    std::env::current_exe()
        .expect("current exe")
        .parent()
        .expect("exe dir")
        .join("../dist")
}

/// Exit after hafley-observe flushes; every exit past `observe::init` goes here.
fn exit(code: i32) -> ! {
    hafley_observe::shutdown();
    std::process::exit(code)
}

fn main() {
    let args = Args::parse();
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    let dist = args.dist.unwrap_or_else(default_dist);
    let doc_root = match args.doc_root {
        Some(path) => match instant_lib::serve::rustdoc::canonical_root(&path) {
            Ok(canon) => Some(canon),
            Err(e) => {
                eprintln!("--doc-root {e}");
                std::process::exit(1);
            }
        },
        None => None,
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("cannot create data dir {}: {e}", data_dir.display());
        std::process::exit(1);
    }
    let host = Arc::new(ServeHost::new(data_dir.clone()));
    let sinks: Vec<Arc<dyn Sink>> = if std::env::var_os(LOG_STREAM_VARIABLE).is_some() {
        vec![Arc::new(LogSink(host.clone()))]
    } else {
        Vec::new()
    };
    match host.state_dir() {
        Ok(dir) => instant_lib::observe::init("instant-serve", &dir, sinks),
        Err(e) => eprintln!("no state dir under {}: {e}", data_dir.display()),
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let services = match Services::boot(&data_dir) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                eprintln!("boot failed in {}: {e}", data_dir.display());
                exit(1);
            }
        };
        services.pty_events.start(host.clone());
        // Register the same root with the loopback doc service the `rustdoc_open`
        // command uses, so the palette and file-open paths work over HTTP here
        // exactly as they do in the native shell.
        if let Some(root) = doc_root.as_deref() {
            if let Err(e) = services.doc_service.register(root) {
                eprintln!("--doc-root {e}");
                exit(1);
            }
        }
        let state = Arc::new(ServeState { host, services, rustdoc_root: doc_root });
        let app = router(state, dist);
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("bind 127.0.0.1:{} failed: {e}", args.port);
                exit(1);
            }
        };
        let port = listener.local_addr().expect("local addr").port();
        println!("listening http://127.0.0.1:{port}");
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("server error: {e}");
            exit(1);
        }
    });
    hafley_observe::shutdown();
}
