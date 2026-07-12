// Filesystem browsing for the Files panel (a Windows-Explorer-style view).
// list_dir returns one directory's entries (dirs first, then files); read_image
// returns a data URL so the preview pane can show media without the asset
// protocol. Custom commands need no capability entry — they're gated by being
// in the invoke handler.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: i64, // unix ms, 0 if unknown
    ext: String, // lowercased extension, "" for dirs / none
}

#[derive(Serialize)]
pub struct DirListing {
    path: String, // canonical dir shown
    parent: Option<String>, // parent dir, None at root
    entries: Vec<Entry>,
}

// Expand a leading ~ and fall back to HOME for empty/None input. Shared with
// meme::save_meme so a user-typed `~/...` path in the Save dialog resolves the
// same way a typed folder path does here.
pub(crate) fn resolve(input: Option<String>) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let raw = input.unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return home.unwrap_or_else(|| PathBuf::from("/"));
    }
    if raw == "~" {
        return home.unwrap_or_else(|| PathBuf::from("/"));
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(h) = home {
            return h.join(rest);
        }
    }
    PathBuf::from(raw)
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ext_of(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return String::new();
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

#[tauri::command]
pub fn list_dir(path: Option<String>) -> Result<DirListing, String> {
    let dir = resolve(path);
    let canon = dir.canonicalize().unwrap_or(dir);
    let rd = std::fs::read_dir(&canon).map_err(|e| format!("{}: {e}", canon.display()))?;

    let mut entries: Vec<Entry> = Vec::new();
    for item in rd.flatten() {
        let p = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue, // skip unreadable (e.g. broken symlink)
        };
        let is_dir = meta.is_dir();
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_ms(&meta),
            ext: ext_of(&p, is_dir),
        });
    }
    // Dirs first, then files; case-insensitive by name within each group.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        parent: canon.parent().map(|p| p.to_string_lossy().into_owned()),
        path: canon.to_string_lossy().into_owned(),
        entries,
    })
}

/// Like `list_dir`, but omits directories that don't contain at least one image
/// file somewhere inside them. Files are also filtered to known image types.
#[tauri::command]
pub fn list_dir_meme(path: Option<String>) -> Result<DirListing, String> {
    let dir = resolve(path);
    let canon = dir.canonicalize().unwrap_or(dir);
    let rd = std::fs::read_dir(&canon).map_err(|e| format!("{}: {e}", canon.display()))?;

    let mut entries: Vec<Entry> = Vec::new();
    for item in rd.flatten() {
        let p = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        if is_dir {
            if !dir_has_image(&p, 0) {
                continue;
            }
        } else {
            let ext = ext_of(&p, false);
            if mime_for(&ext).is_none() {
                continue;
            }
        }
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_ms(&meta),
            ext: ext_of(&p, is_dir),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        parent: canon.parent().map(|p| p.to_string_lossy().into_owned()),
        path: canon.to_string_lossy().into_owned(),
        entries,
    })
}

/// Return true if `dir` contains at least one image file (recursively).
fn dir_has_image(dir: &Path, depth: usize) -> bool {
    if depth > 10 {
        return false;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return false,
    };
    for item in rd.flatten() {
        let ft = match item.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let p = item.path();
        if ft.is_dir() {
            if dir_has_image(&p, depth + 1) {
                return true;
            }
        } else {
            let ext = ext_of(&p, false);
            if mime_for(&ext).is_some() {
                return true;
            }
        }
    }
    false
}

/// Recursively list files under a directory.
///
/// `exts` optionally filters to the given extensions (case-insensitive).
/// `max_depth` defaults to 6; `max_files` defaults to 2000.
#[tauri::command]
pub fn list_dir_recursive(
    path: Option<String>,
    exts: Option<Vec<String>>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<DirListing, String> {
    let dir = resolve(path);
    let canon = dir.canonicalize().unwrap_or(dir);
    let max_depth = max_depth.unwrap_or(6);
    let max_files = max_files.unwrap_or(2000);
    let mut entries: Vec<Entry> = Vec::new();
    collect_files(
        &canon,
        &canon,
        0,
        max_depth,
        max_files,
        exts.as_deref(),
        &mut entries,
    )?;
    entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(DirListing {
        parent: canon.parent().map(|p| p.to_string_lossy().into_owned()),
        path: canon.to_string_lossy().into_owned(),
        entries,
    })
}

fn collect_files(
    base: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    max_files: usize,
    exts: Option<&[String]>,
    out: &mut Vec<Entry>,
) -> Result<(), String> {
    if depth > max_depth || out.len() >= max_files {
        return Ok(());
    }
    let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for item in rd.flatten() {
        if out.len() >= max_files {
            break;
        }
        let ft = match item.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let p = item.path();
        if ft.is_dir() {
            collect_files(base, &p, depth + 1, max_depth, max_files, exts, out)?;
        } else if ft.is_file() {
            let ext = ext_of(&p, false);
            if let Some(list) = exts {
                if !list.iter().any(|e| e.eq_ignore_ascii_case(&ext)) {
                    continue;
                }
            }
            let meta = match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(Entry {
                name: item.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                is_dir: false,
                size: meta.len(),
                modified: modified_ms(&meta),
                ext,
            });
        }
    }
    Ok(())
}

const MAX_PREVIEW: u64 = 12 * 1024 * 1024; // 12 MB cap for inline previews

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// Read a (small) image file as a `data:` URL for the preview pane. Errors if
/// the extension isn't a known image type or the file is over the size cap.
#[tauri::command]
pub fn read_image(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = ext_of(&p, false);
    let mime = mime_for(&ext).ok_or_else(|| "not an image".to_string())?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_PREVIEW {
        return Err("image too large to preview".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Read a UTF-8 text file for the preview pane. Caps size, rejects binary
/// (any NUL in the first 8 KB) and non-UTF-8 so the webview never gets a blob
/// it can't render.
#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    let p = resolve(Some(path));
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("file too large to preview".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "not valid UTF-8".to_string())
}

// Minimal base64 (standard alphabet) — avoids pulling a crate for one use.
fn base64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(A[((n >> 18) & 63) as usize] as char);
        out.push(A[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            A[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            A[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
