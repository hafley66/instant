// Bounded static serving for one generated cargo doc tree. rustdoc loads its
// search index with fetch(), which Chrome blocks from a file:// origin, so the
// doc tree is served over the existing HTTP origin instead. This resolver is the
// only gate between a URL path and the filesystem: it drops `..` segments, then
// re-checks every canonicalized target against the canonical root so a symlink
// inside the tree cannot point out of it. Responding is left to
// tower_http::services::ServeFile, which owns content type and byte serving.
//
// Path parts arrive already percent-decoded from axum's Path extractor, so this
// module decodes nothing; a second decode would corrupt filenames holding a
// literal `%`.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use tower_http::services::ServeFile;

#[derive(Debug, PartialEq, Eq)]
pub enum DocError {
    Forbidden,
    NotFound,
}

/// Canonicalize a doc root once at startup. Rejecting a non-directory here means
/// the serve route never has to distinguish "no root" from "bad root".
pub fn canonical_root(path: &Path) -> Result<PathBuf, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !canon.is_dir() {
        return Err(format!("{} is not a directory", canon.display()));
    }
    Ok(canon)
}

/// Map a decoded URL path below the doc root to a real file inside `root`. A
/// directory resolves to its index.html, and that final target is canonicalized
/// and re-checked so a symlinked index.html cannot escape either.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, DocError> {
    if rel.contains('\0') {
        return Err(DocError::Forbidden);
    }
    let mut candidate = root.to_path_buf();
    for segment in rel.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(DocError::Forbidden);
        }
        candidate.push(segment);
    }
    let canon = std::fs::canonicalize(&candidate).map_err(|_| DocError::NotFound)?;
    if !canon.starts_with(root) {
        return Err(DocError::Forbidden);
    }
    let target = if canon.is_dir() {
        canon.join("index.html")
    } else {
        canon
    };
    let final_path = std::fs::canonicalize(&target).map_err(|_| DocError::NotFound)?;
    if !final_path.starts_with(root) {
        return Err(DocError::Forbidden);
    }
    if !final_path.is_file() {
        return Err(DocError::NotFound);
    }
    Ok(final_path)
}

/// Top-level directories that hold an index.html, which is exactly the set of
/// crates rustdoc emitted. Used for the `/rustdoc/` listing page.
pub fn crate_list(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("index.html").is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn listing_html(root: &Path) -> String {
    let mut links = String::new();
    for name in crate_list(root) {
        let href = format!("{name}/index.html");
        links.push_str(&format!(
            "<li><a href=\"{}\">{}</a></li>",
            escape_html(&href),
            escape_html(&name)
        ));
    }
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Generated documentation</title></head><body>\
<h1>Generated documentation</h1><ul>{links}</ul></body></html>"
    )
}

/// The rustdoc output root for an HTML file: the nearest ancestor directory
/// holding `crates.js`, the marker rustdoc writes at the root of a `target/doc`
/// tree. `None` when the file sits under no such directory, which is how a
/// plain HTML file stays on the normal file-open path.
pub fn find_root(file: &Path) -> Option<PathBuf> {
    for dir in file.ancestors().skip(1) {
        if dir.join("crates.js").is_file() {
            return std::fs::canonicalize(dir).ok();
        }
    }
    None
}

/// True when a path is shaped like `.../target/doc/...`, used to tell "you have
/// not generated docs yet" apart from "this is not a doc page".
pub fn looks_generated(file: &Path) -> bool {
    let parts: Vec<&std::ffi::OsStr> = file
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n),
            _ => None,
        })
        .collect();
    parts
        .windows(2)
        .any(|w| w[0] == std::ffi::OsStr::new("target") && w[1] == std::ffi::OsStr::new("doc"))
}

/// `file`'s slash-joined path below `root`, or `None` when it is outside or its
/// components are not plain names. Callers canonicalize both first.
pub fn relative_path(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(n) => parts.push(n.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Percent-encode a slash-joined path for a URL, keeping `/` as the separator
/// and escaping every byte outside the unreserved set. The doc path can contain
/// a space (the target directory often does), which cannot ride a URL raw.
pub fn percent_encode_path(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len());
    for b in rel.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A minimal router that serves one doc root: `/` lists the crates and
/// `/{*path}` resolves through the containment-checked resolver. Used by the
/// serve binary under `/rustdoc` and by the native loopback doc service, so
/// both share one decoding and containment boundary. `Router<()>` so it nests
/// into another router that carries its own state.
pub fn doc_router(root: PathBuf) -> axum::Router {
    axum::Router::new()
        .route("/", axum::routing::get(doc_listing))
        .route("/{*path}", axum::routing::get(doc_file))
        .with_state(Arc::new(root))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

async fn doc_listing(State(root): State<Arc<PathBuf>>) -> Response {
    let html = listing_html(&root);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

async fn doc_file(
    State(root): State<Arc<PathBuf>>,
    AxumPath(path): AxumPath<String>,
    request: Request,
) -> Response {
    let file = match resolve(&root, &path) {
        Ok(file) => file,
        Err(_) => return not_found(),
    };
    match ServeFile::new(&file).try_call(request).await {
        Ok(response) => response.map(axum::body::Body::new),
        Err(_) => not_found(),
    }
}
