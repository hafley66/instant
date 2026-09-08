// instant-serve: the whole backend with no Tauri in the process. Serves the
// built frontend over HTTP and the command table over a JSON-RPC 2.0 WebSocket.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;

use instant_lib::serve::{router, ServeHost, ServeState, Services};

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

fn main() {
    let args = Args::parse();
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    let dist = args.dist.unwrap_or_else(default_dist);
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("cannot create data dir {}: {e}", data_dir.display());
        std::process::exit(1);
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
                std::process::exit(1);
            }
        };
        let host = Arc::new(ServeHost::new(data_dir.clone()));
        services.pty_events.start(host.clone());
        let state = Arc::new(ServeState { host, services });
        let app = router(state, dist);
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("bind 127.0.0.1:{} failed: {e}", args.port);
                std::process::exit(1);
            }
        };
        let port = listener.local_addr().expect("local addr").port();
        println!("listening http://127.0.0.1:{port}");
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("server error: {e}");
            std::process::exit(1);
        }
    });
}
