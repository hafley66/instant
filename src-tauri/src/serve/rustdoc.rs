// Bounded static serving for one generated cargo doc tree. rustdoc loads its
// search index with fetch(), which Chrome blocks from a file:// origin, so the
// doc tree is served over the existing HTTP origin instead. This resolver is the
// only gate between a URL path and the filesystem: it drops absolute and `..`
// segments, then re-checks the canonicalized result against the canonical root so
// a symlink inside the tree cannot point out of it.

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

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Map a URL path below the doc root to a file inside the canonical `root`.
pub fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, &'static str), DocError> {
    let rel = rel.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(rel).ok_or(DocError::Forbidden)?;
    if decoded.contains('\0') {
        return Err(DocError::Forbidden);
    }
    let mut candidate = root.to_path_buf();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(DocError::Forbidden);
        }
        candidate.push(segment);
    }
    let mut canon = std::fs::canonicalize(&candidate).map_err(|_| DocError::NotFound)?;
    if !canon.starts_with(root) {
        return Err(DocError::Forbidden);
    }
    if canon.is_dir() {
        canon = canon.join("index.html");
        if !canon.is_file() {
            return Err(DocError::NotFound);
        }
    }
    if !canon.is_file() {
        return Err(DocError::NotFound);
    }
    let mime = mime_for(&canon);
    Ok((canon, mime))
}

pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
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

