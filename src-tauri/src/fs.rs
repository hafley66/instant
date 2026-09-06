// Filesystem browsing for the Files panel (a Windows-Explorer-style view).
// list_dir returns one directory's entries (dirs first, then files); read_image
// returns a data URL so the preview pane can show media without the asset
// protocol. Custom commands need no capability entry — they're gated by being
// in the invoke handler.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: i64, // unix ms, 0 if unknown
    ext: String,   // lowercased extension, "" for dirs / none
}

#[derive(Serialize)]
pub struct DirListing {
    path: String,           // canonical dir shown
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
pub async fn list_dir(path: Option<String>) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir_blocking(path: Option<String>) -> Result<DirListing, String> {
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
pub async fn list_dir_meme(path: Option<String>) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_meme_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir_meme_blocking(path: Option<String>) -> Result<DirListing, String> {
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
pub async fn list_dir_recursive(
    path: Option<String>,
    exts: Option<Vec<String>>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_dir_recursive_blocking(path, exts, max_depth, max_files)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_dir_recursive_blocking(
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

/// Gitignore-aware file candidates for the generic filesystem search UI. The
/// client owns fzf-style query ranking, while this walker owns filesystem and
/// ignore semantics. Directories are excluded because FileSearchTree retains
/// its lazy expandable directory browser beside search results.
#[tauri::command]
pub async fn search_files(
    path: Option<String>,
    max_files: Option<usize>,
) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || search_files_blocking(path, max_files))
        .await
        .map_err(|e| e.to_string())?
}

fn search_files_blocking(
    path: Option<String>,
    max_files: Option<usize>,
) -> Result<Vec<Entry>, String> {
    let dir = resolve(path);
    let canon = dir.canonicalize().unwrap_or(dir);
    let cap = max_files.unwrap_or(20_000);
    let mut entries = Vec::new();
    let mut builder = WalkBuilder::new(&canon);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false);
    for result in builder.build() {
        if entries.len() >= cap {
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let p = entry.into_path();
        let meta = match std::fs::metadata(&p) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push(Entry {
            name: p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir: false,
            size: meta.len(),
            modified: modified_ms(&meta),
            ext: ext_of(&p, false),
        });
    }
    entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(entries)
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
        "tif" | "tiff" => Some("image/tiff"),
        "heic" => Some("image/heic"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

/// Read a bounded image or PDF file as a `data:` URL for the preview pane.
#[tauri::command]
pub async fn read_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_image_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_image_blocking(path: String) -> Result<String, String> {
    let p = resolve(Some(path));
    let ext = ext_of(&p, false);
    let mime = mime_for(&ext).ok_or_else(|| "not an image".to_string())?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_PREVIEW {
        return Err("image too large to preview".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Write UTF-8 text to a user-selected path, creating missing parent directories.
#[tauri::command]
pub async fn save_text(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_text_blocking(path, contents))
        .await
        .map_err(|e| e.to_string())?
}

fn save_text_blocking(path: String, contents: String) -> Result<(), String> {
    let resolved = resolve(Some(path));
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }
    std::fs::write(&resolved, contents).map_err(|e| format!("{}: {e}", resolved.display()))
}

/// Delete one user-selected file. Directories are rejected so a Paint recent
/// entry can never remove a tree by mistake.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_file_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_file_blocking(path: String) -> Result<(), String> {
    let resolved = resolve(Some(path));
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("{}: {e}", resolved.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", resolved.display()));
    }
    std::fs::remove_file(&resolved).map_err(|e| format!("{}: {e}", resolved.display()))
}

/// Read a UTF-8 text file for the preview pane. Caps size, rejects binary
/// (any NUL in the first 8 KB) and non-UTF-8 so the webview never gets a blob
/// it can't render.
#[tauri::command]
pub async fn read_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_text_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_text_blocking(path: String) -> Result<String, String> {
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


// Dropped-image stash. macOS deletes the promise file behind a screenshot /
// Photos / Mail drag the instant the drop finishes; copying beats every hop.

/// One dropped path after the stash pass. `stashed: None` with a `reason` means
/// the original was left alone (not an image, too big, unreadable).
#[derive(Serialize, Clone)]
pub struct StashedDrop {
    source: String,
    stashed: Option<String>,
    bytes: u64,
    reason: Option<String>,
}

// A dropped file over this is left alone: copying it costs more than the drop
// is worth, and no agent takes a 200 MB image off the pasteboard anyway.
const MAX_STASH: u64 = 200 * 1024 * 1024;

// Mirrors IMAGE_EXTS in src/core.ts. Extension is the first test; magic bytes
// cover a promise file whose suffix is wrong or missing.
const STASH_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff", "heic",
];

// Same source path dropped twice inside this window returns the same copy, so a
// second window seeing the same native event cannot double-copy a 100 MB photo.
const DEDUPE_WINDOW: Duration = Duration::from_secs(2);

// (source path, stashed path, when). Pruned on every call; only ever holds the
// handful of paths from the last drop.
static RECENT_STASH: Mutex<Vec<(String, String, SystemTime)>> = Mutex::new(Vec::new());

/// Copy every dropped image to `~/.agent/drops`. Never fails as a whole: an
/// unstashable path comes back with a reason and the caller keeps the original.
#[tauri::command]
pub async fn stash_drop(paths: Vec<String>) -> Vec<StashedDrop> {
    let sources = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stash_drop_blocking(paths, &stash_dir(), SystemTime::now())
    })
    .await
    .unwrap_or_else(|e| {
        sources
            .into_iter()
            .map(|source| refused(source, 0, e.to_string()))
            .collect()
    })
}

fn stash_drop_blocking(paths: Vec<String>, dir: &Path, now: SystemTime) -> Vec<StashedDrop> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        if let Some(hit) = recent_stash(&path, now) {
            let bytes = std::fs::metadata(&hit).map(|m| m.len()).unwrap_or(0);
            out.push(StashedDrop {
                source: path,
                stashed: Some(hit),
                bytes,
                reason: None,
            });
            continue;
        }
        let drop = stash_one(Path::new(&path), dir, now);
        if let Some(stashed) = drop.stashed.as_deref() {
            remember_stash(&drop.source, stashed, now);
        }
        out.push(drop);
    }
    out
}

/// The stashed copy of `source` from a drop less than `DEDUPE_WINDOW` ago, if
/// that copy is still on disk.
fn recent_stash(source: &str, now: SystemTime) -> Option<String> {
    let mut recent = RECENT_STASH.lock().ok()?;
    recent.retain(|(_, _, at)| {
        now.duration_since(*at)
            .map(|age| age < DEDUPE_WINDOW)
            .unwrap_or(false)
    });
    recent
        .iter()
        .find(|(src, stashed, _)| src == source && Path::new(stashed).exists())
        .map(|(_, stashed, _)| stashed.clone())
}

fn remember_stash(source: &str, stashed: &str, now: SystemTime) {
    if let Ok(mut recent) = RECENT_STASH.lock() {
        recent.push((source.to_string(), stashed.to_string(), now));
    }
}

/// Where stashed drops live. `~/.agent/drops`, created on first drop.
fn stash_dir() -> PathBuf {
    resolve(Some("~/.agent/drops".to_string()))
}

fn refused(source: String, bytes: u64, reason: impl Into<String>) -> StashedDrop {
    StashedDrop {
        source,
        stashed: None,
        bytes,
        reason: Some(reason.into()),
    }
}

fn stash_one(source: &Path, dir: &Path, now: SystemTime) -> StashedDrop {
    let source_str = source.to_string_lossy().into_owned();
    let meta = match std::fs::metadata(source) {
        Ok(meta) => meta,
        // Already gone: the promise file beat us. Nothing to copy, and the
        // caller still gets to see which path evaporated.
        Err(e) => return refused(source_str, 0, e.to_string()),
    };
    if !meta.is_file() {
        return refused(source_str, 0, "not a file");
    }
    let bytes = meta.len();
    let ext = ext_of(source, false);
    if !STASH_IMAGE_EXTS.contains(&ext.as_str()) && !head_is_image(source) {
        return refused(source_str, bytes, "not an image");
    }
    if bytes > MAX_STASH {
        return refused(
            source_str,
            bytes,
            format!("{bytes} bytes is over the {MAX_STASH} byte stash limit"),
        );
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        return refused(source_str, bytes, format!("{}: {e}", dir.display()));
    }
    let dest = match free_name(dir, &stash_name(source, now)) {
        Some(dest) => dest,
        None => return refused(source_str, bytes, "no free name in the stash dir"),
    };
    match std::fs::copy(source, &dest) {
        Ok(_) => StashedDrop {
            source: source_str,
            stashed: Some(dest.to_string_lossy().into_owned()),
            bytes,
            reason: None,
        },
        Err(e) => refused(source_str, bytes, format!("{}: {e}", dest.display())),
    }
}

/// `<YYYYMMDD-HHMMSS>-<sanitized basename>`, local time, so the stash dir sorts
/// chronologically and a file keeps the name its author gave it.
fn stash_name(source: &Path, now: SystemTime) -> String {
    let base = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{}-{}", local_stamp(now), sanitize_name(&base))
}

/// Keep letters, digits, dot, dash and underscore; everything else (spaces,
/// slashes, colons a screenshot name is full of) becomes one dash.
fn sanitize_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    if trimmed.is_empty() {
        "drop".to_string()
    } else {
        trimmed.to_string()
    }
}

/// First unused name: `name`, then `name-2`, … with the suffix ahead of the
/// extension, which is what `boop beep paste` reads to pick a pasteboard class.
fn free_name(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return Some(candidate);
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2..1000)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
}

fn local_stamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // localtime_r fills `tm` in the machine's zone; a null return leaves the
    // zeroed struct, which still yields a well-formed (if wrong) stamp.
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// Image signatures, for a promise file whose name says nothing.
fn head_is_image(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut filled = 0;
    while filled < head.len() {
        match f.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return false,
        }
    }
    is_image_magic(&head[..filled])
}

fn is_image_magic(head: &[u8]) -> bool {
    let starts = |sig: &[u8]| head.len() >= sig.len() && &head[..sig.len()] == sig;
    if starts(b"\x89PNG\r\n\x1a\n")            // png
        || starts(b"\xff\xd8\xff")             // jpeg
        || starts(b"GIF87a")
        || starts(b"GIF89a")
        || starts(b"BM")                       // bmp
        || starts(b"II*\0")                    // tiff, little endian
        || starts(b"MM\0*")                    // tiff, big endian
    {
        return true;
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return true;
    }
    // ISO base media: heic/heif/avif all sit behind an `ftyp` box brand.
    head.len() >= 12
        && &head[4..8] == b"ftyp"
        && matches!(
            &head[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" | b"heif" | b"avif"
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    // Each test owns a fresh dir under the system temp dir; nothing here touches
    // the real ~/.agent/drops.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "instant-stash-{}-{name}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
            p
        }
        fn sub(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn stashes_an_image_named_like_one() {
        let s = Scratch::new("ext");
        let src = s.write("Screenshot 2026-09-05 at 11.40.58 PM.png", PNG);
        let dir = s.sub("drops");
        let out = stash_one(&src, &dir, at(1_757_000_000));
        let stashed = out.stashed.expect("image is stashed");
        assert_eq!(out.reason, None);
        assert_eq!(out.bytes, PNG.len() as u64);
        assert_eq!(std::fs::read(&stashed).unwrap(), PNG);
        let name = Path::new(&stashed).file_name().unwrap().to_str().unwrap();
        assert!(name.ends_with("-Screenshot-2026-09-05-at-11.40.58-PM.png"), "{name}");
        // The copy outlives the original, which is what the drop race destroys.
        std::fs::remove_file(&src).unwrap();
        assert!(Path::new(&stashed).exists());
    }

    #[test]
    fn stashes_an_image_whose_extension_lies() {
        let s = Scratch::new("magic");
        let src = s.write("promise-file", PNG);
        let dir = s.sub("drops");
        let out = stash_one(&src, &dir, at(1_757_000_000));
        assert!(out.stashed.is_some(), "magic bytes carry it: {:?}", out.reason);
    }

    #[test]
    fn leaves_a_non_image_alone() {
        let s = Scratch::new("text");
        let src = s.write("notes.txt", b"plain text, no signature");
        let dir = s.sub("drops");
        let out = stash_one(&src, &dir, at(1_757_000_000));
        assert_eq!(out.stashed, None);
        assert_eq!(out.reason.as_deref(), Some("not an image"));
        assert!(!dir.exists(), "no stash dir for a file we never copy");
    }

    #[test]
    fn refuses_an_image_over_the_limit() {
        let s = Scratch::new("big");
        let src = s.write("huge.png", PNG);
        let dir = s.sub("drops");
        // Sparse file: no 200 MB written, but metadata reports the length.
        let f = std::fs::OpenOptions::new().write(true).open(&src).unwrap();
        f.set_len(MAX_STASH + 1).unwrap();
        drop(f);
        let out = stash_one(&src, &dir, at(1_757_000_000));
        assert_eq!(out.stashed, None);
        assert_eq!(out.bytes, MAX_STASH + 1);
        assert!(out.reason.unwrap().contains("stash limit"));
    }

    #[test]
    fn a_second_drop_of_the_same_name_gets_a_suffix() {
        let s = Scratch::new("collide");
        let a = s.write("shot.png", PNG);
        let b = s.write("other/shot.png", PNG);
        let dir = s.sub("drops");
        let first = stash_one(&a, &dir, at(1_757_000_000)).stashed.unwrap();
        let second = stash_one(&b, &dir, at(1_757_000_000)).stashed.unwrap();
        assert_ne!(first, second);
        assert!(first.ends_with("-shot.png"), "{first}");
        assert!(second.ends_with("-shot-2.png"), "{second}");
    }

    #[test]
    fn the_same_source_twice_inside_the_window_yields_one_copy() {
        let s = Scratch::new("dedupe");
        let src = s.write("dup.png", PNG);
        let dir = s.sub("drops");
        let src = src.to_string_lossy().into_owned();
        let now = at(1_757_000_100);
        let first = stash_drop_blocking(vec![src.clone()], &dir, now);
        let again = stash_drop_blocking(vec![src], &dir, now + Duration::from_millis(300));
        assert_eq!(first[0].stashed, again[0].stashed);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn magic_table_covers_the_formats_a_drag_produces() {
        assert!(is_image_magic(b"\xff\xd8\xff\xe0"));
        assert!(is_image_magic(b"GIF89a\0\0\0\0\0\0"));
        assert!(is_image_magic(b"RIFF\0\0\0\0WEBP"));
        assert!(is_image_magic(b"\0\0\0\x18ftypheic"));
        assert!(is_image_magic(b"II*\0\0\0\0\0\0\0\0\0"));
        assert!(!is_image_magic(b"#!/bin/sh\n\0\0\0"));
        assert!(!is_image_magic(b""));
    }
}
