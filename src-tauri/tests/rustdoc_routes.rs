// Real-HTTP tests for the /rustdoc route table: the router is served on a
// loopback port and queried over a TCP socket, so the extracted path has been
// percent-decoded exactly as a browser's request would be.

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use instant_lib::serve::{router, ServeHost, ServeState, Services};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "instant-rustdoc-route-{}-{n}-{label}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn spin(doc_root: Option<PathBuf>) -> SocketAddr {
    let dir = scratch("serve");
    let services = Arc::new(Services::boot(&dir).expect("services boot"));
    let host = Arc::new(ServeHost::new(dir.clone()));
    let state = Arc::new(ServeState { host, services, rustdoc_root: doc_root });
    let app = router(state, dir);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

fn status(addr: SocketAddr, method: &str, path: &str) -> u16 {
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let request =
        format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).expect("write");
    let mut buffer = Vec::new();
    let _ = stream.read_to_end(&mut buffer);
    let text = String::from_utf8_lossy(&buffer);
    text.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

fn doc_root_with_crate() -> PathBuf {
    let root = scratch("doc");
    std::fs::create_dir_all(root.join("docprobe")).unwrap();
    std::fs::write(root.join("docprobe/index.html"), "<html>crate</html>").unwrap();
    std::fs::write(root.join("percent%name.html"), "<html>percent</html>").unwrap();
    // The serve flag canonicalizes the root before storing it; mirror that, or a
    // /var -> /private/var symlink makes the prefix check fail on macOS.
    instant_lib::serve::rustdoc::canonical_root(&root).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_rustdoc_path_is_404_when_no_root_is_configured() {
    let addr = spin(None).await;
    for path in ["/rustdoc/", "/rustdoc/docprobe/index.html", "/rustdoc/percent%25name.html"] {
        assert_eq!(status(addr, "GET", path), 404, "no-root {path}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rooted_serves_listing_index_head_and_percent_and_rejects_encoded_traversal() {
    let addr = spin(Some(doc_root_with_crate())).await;
    assert_eq!(status(addr, "GET", "/rustdoc/"), 200, "listing");
    assert_eq!(status(addr, "HEAD", "/rustdoc/"), 200, "listing HEAD");
    assert_eq!(status(addr, "GET", "/rustdoc/docprobe/index.html"), 200, "index");
    // A literal percent in a filename survives the one decode boundary.
    assert_eq!(status(addr, "GET", "/rustdoc/percent%25name.html"), 200, "percent");
    // Encoded traversal is decoded by the extractor into `..` and rejected.
    assert_eq!(status(addr, "GET", "/rustdoc/..%2f..%2fCargo.toml"), 404, "encoded ../");
    assert_eq!(status(addr, "GET", "/rustdoc/%2e%2e%2fCargo.toml"), 404, "encoded dotdot");
}
