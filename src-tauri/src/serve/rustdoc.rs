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

use std::path::{Path, PathBuf};

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
