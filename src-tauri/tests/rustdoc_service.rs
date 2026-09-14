// Real-filesystem + real-HTTP tests for the backend-owned loopback doc service.
// The service is started on an ephemeral port and queried over a TCP socket, so
// this exercises the same decoding, containment, and ServeFile path the native
// shell and instant-serve share. The root path contains a space so the URL
// percent-encoding boundary is covered too.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use instant_lib::doc_service::{open_impl, DocService};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "instant-rustdoc-svc-{}-{n}-{label} with spaces",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture() -> PathBuf {
    let root = scratch("root");
    std::fs::write(root.join("crates.js"), "// crates").unwrap();
    std::fs::create_dir_all(root.join("docprobe/static.files")).unwrap();
    std::fs::write(
        root.join("docprobe/index.html"),
        "<html><title>docprobe</title>crate</html>",
    )
    .unwrap();
    std::fs::write(root.join("docprobe/struct.Pair.html"), "<html>Pair</html>").unwrap();
    std::fs::write(root.join("docprobe/static.files/main.js"), "// js").unwrap();
    std::fs::write(root.join("100%.html"), "<html>percent</html>").unwrap();
    root
}

fn get(port: u16, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).expect("write");
    let mut buffer = Vec::new();
    let _ = stream.read_to_end(&mut buffer);
    let text = String::from_utf8_lossy(&buffer).into_owned();
    let code = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (code, text)
}

fn port_of(url: &str) -> (u16, String) {
    let rest = url.strip_prefix("http://127.0.0.1:").expect("loopback url");
    let (port, path) = rest.split_once('/').expect("url path");
    (port.parse().expect("port"), format!("/{path}"))
}

#[test]
fn serves_a_registered_root_over_loopback() {
    let root = fixture();
    let service = DocService::default();
    let port = service.register(&root).unwrap();

    let (status, listing) = get(port, "/");
    assert_eq!(status, 200);
    assert!(listing.contains("docprobe/index.html"), "{listing}");
    assert_eq!(get(port, "/docprobe/index.html").0, 200);
    assert_eq!(get(port, "/docprobe/struct.Pair.html").0, 200);
    assert_eq!(get(port, "/docprobe/static.files/main.js").0, 200);
    // A literal percent in a filename survives the single decode boundary.
    assert_eq!(get(port, "/100%25.html").0, 200);
    assert_eq!(get(port, "/missing.html").0, 404);
    // Encoded traversal is decoded once and rejected by the resolver.
    assert_eq!(get(port, "/..%2f..%2fCargo.toml").0, 404);
    service.stop_all();
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_index_escaping_the_root() {
    let root = fixture();
    let outside =
        std::env::temp_dir().join(format!("instant-rustdoc-outside-{}.html", std::process::id()));
    std::fs::write(&outside, "<html>secret</html>").unwrap();
    std::fs::create_dir_all(root.join("linked")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("linked/index.html")).unwrap();

    let service = DocService::default();
    let port = service.register(&root).unwrap();
    assert_eq!(get(port, "/linked/index.html").0, 404);
    assert_eq!(get(port, "/linked").0, 404);
    let _ = std::fs::remove_file(&outside);
    service.stop_all();
}

#[test]
fn register_reuses_one_server_per_canonical_root() {
    let root = fixture();
    let service = DocService::default();
    let first = service.register(&root).unwrap();
    let second = service.register(&root).unwrap();
    assert_eq!(first, second);
    service.stop_all();
}

#[test]
fn open_impl_maps_a_selected_page_to_an_encoded_loopback_url() {
    let root = fixture();
    let service = DocService::default();
    let page = root.join("docprobe/index.html");
    let url = open_impl(&service, Some(&page)).unwrap().expect("url");
    let (port, path) = port_of(&url);
    assert_eq!(path, "/docprobe/index.html");
    assert!(!path.contains(' '), "raw space in {url}");
    assert_eq!(get(port, &path).0, 200);
    service.stop_all();
}

#[test]
fn open_impl_declines_a_plain_html_file() {
    let dir = scratch("plain");
    let file = dir.join("plain.html");
    std::fs::write(&file, "<html>plain</html>").unwrap();
    let service = DocService::default();
    assert_eq!(open_impl(&service, Some(&file)).unwrap(), None);
    // A path that is not rustdoc-shaped and does not exist is also declined, so
    // the normal file-open path still owns the error.
    let missing = dir.join("nope.html");
    assert_eq!(open_impl(&service, Some(&missing)).unwrap(), None);
}

#[test]
fn open_impl_reports_missing_generated_docs() {
    let dir = scratch("missing");
    std::fs::create_dir_all(dir.join("target/doc/mycrate")).unwrap();
    let page = dir.join("target/doc/mycrate/index.html");
    std::fs::write(&page, "<html>gone</html>").unwrap();
    let service = DocService::default();
    let error = open_impl(&service, Some(&page)).unwrap_err();
    assert!(error.contains("cargo doc"), "{error}");

    // The output directory may not exist yet; the shape alone is enough.
    let absent = dir.join("target/doc/notbuilt/index.html");
    let error = open_impl(&service, Some(&absent)).unwrap_err();
    assert!(error.contains("cargo doc"), "{error}");
}

#[test]
fn palette_opens_the_last_registered_root_or_explains() {
    let root = fixture();
    let service = DocService::default();
    let error = open_impl(&service, None).unwrap_err();
    assert!(error.contains("no documentation root"), "{error}");

    let port = service.register(&root).unwrap();
    let url = open_impl(&service, None).unwrap().expect("url");
    assert_eq!(url, format!("http://127.0.0.1:{port}/"));
    service.stop_all();
}
