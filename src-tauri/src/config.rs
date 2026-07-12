// Observation filters. A JSON config at app_data_dir/config.json lists patterns
// that exclude events from the activity store BEFORE they're recorded:
//   exclude_sites -> matched against a browser event's URL
//   exclude_files -> matched against an opened file's path
//   exclude_apps  -> matched against the frontmost app; the screenshot is never
//                    even taken while that app is front.
// Patterns are case-insensitive: plain text is a substring match, and '*' is a
// wildcard (anchored glob), so "reddit.com", "*.bank.com", "secret*", "*.env"
// all work. Filtering is block-future-only — existing rows are left untouched
// (use Clear for those). The Config panel reads and edits this file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub exclude_sites: Vec<String>,
    #[serde(default)]
    pub exclude_files: Vec<String>,
    #[serde(default)]
    pub exclude_apps: Vec<String>,
}

#[derive(Clone)]
pub struct ConfigStatus {
    pub source: String,        // "file" | "default"
    pub error: Option<String>, // parse error, if the file was unreadable
}

/// Process-lifetime managed state. The config is read on every ingest / file
/// open / capture, so it sits behind a Mutex; the drop counter is atomic.
pub struct ConfigState {
    pub config: Mutex<AppConfig>,
    pub path: PathBuf,
    pub status: Mutex<ConfigStatus>,
    pub excluded_count: AtomicU64, // events blocked since launch
}

// What the Config panel renders.
#[derive(Serialize)]
pub struct ConfigView {
    pub path: String,
    pub source: String,
    pub error: Option<String>,
    pub exclude_sites: Vec<String>,
    pub exclude_files: Vec<String>,
    pub exclude_apps: Vec<String>,
    pub excluded_count: u64,
}

impl AppConfig {
    pub fn site_excluded(&self, url: &str) -> bool {
        // Match the full URL (catches path substrings) and the bare host (so an
        // end-anchored glob like "*.bank.com" works despite the trailing path).
        any_match(&self.exclude_sites, url) || any_match(&self.exclude_sites, host_of(url))
    }
    pub fn file_excluded(&self, path: &str) -> bool {
        any_match(&self.exclude_files, path)
    }
    pub fn app_excluded(&self, app: &str) -> bool {
        any_match(&self.exclude_apps, app)
    }
}

// Host portion of a URL: drop the scheme, then take up to the first /, ?, or #.
fn host_of(url: &str) -> &str {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    after.split(['/', '?', '#']).next().unwrap_or(after)
}

fn any_match(patterns: &[String], text: &str) -> bool {
    let t = text.to_lowercase();
    patterns
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .any(|p| glob_match(&p.to_lowercase(), &t))
}

// Case-insensitive (caller lowercases both). No '*' -> substring. With '*' ->
// segments must appear in order, anchored at the ends unless the pattern starts
// / ends with '*'.
fn glob_match(pattern: &str, text: &str) -> bool {
    if !pattern.contains('*') {
        return text.contains(pattern);
    }
    let segs: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0usize;
    for (i, seg) in segs.iter().enumerate() {
        if seg.is_empty() {
            continue;
        }
        if i == 0 {
            if !text[pos..].starts_with(seg) {
                return false;
            }
            pos += seg.len();
        } else if i == segs.len() - 1 {
            if text.len() < pos + seg.len() || !text.ends_with(seg) {
                return false;
            }
        } else {
            match text[pos..].find(seg) {
                Some(f) => pos += f + seg.len(),
                None => return false,
            }
        }
    }
    true
}

/// Read config.json, writing a default if absent. Returns the config and how it
/// was sourced (file vs default-on-error).
pub fn read_or_default(path: &Path) -> (AppConfig, ConfigStatus) {
    if !path.exists() {
        let def = AppConfig::default();
        let _ = write_file(path, &def);
        return (
            def,
            ConfigStatus {
                source: "default".into(),
                error: None,
            },
        );
    }
    match std::fs::read_to_string(path).map(|s| serde_json::from_str::<AppConfig>(&s)) {
        Ok(Ok(cfg)) => (
            cfg,
            ConfigStatus {
                source: "file".into(),
                error: None,
            },
        ),
        Ok(Err(e)) => (
            AppConfig::default(),
            ConfigStatus {
                source: "default".into(),
                error: Some(format!("parse error: {e}")),
            },
        ),
        Err(e) => (
            AppConfig::default(),
            ConfigStatus {
                source: "default".into(),
                error: Some(format!("read error: {e}")),
            },
        ),
    }
}

fn write_file(path: &Path, cfg: &AppConfig) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(cfg).unwrap_or_else(|_| "{}".into());
    std::fs::write(path, json)
}

fn view(state: &ConfigState) -> ConfigView {
    let cfg = state.config.lock().unwrap().clone();
    let status = state.status.lock().unwrap().clone();
    ConfigView {
        path: state.path.to_string_lossy().into_owned(),
        source: status.source,
        error: status.error,
        exclude_sites: cfg.exclude_sites,
        exclude_files: cfg.exclude_files,
        exclude_apps: cfg.exclude_apps,
        excluded_count: state.excluded_count.load(Ordering::Relaxed),
    }
}

/// Bump the blocked-event counter (called at each enforcement point).
pub fn note_excluded(state: &ConfigState) {
    state.excluded_count.fetch_add(1, Ordering::Relaxed);
}

// api(http GET /api/v1/config): config_get
#[tauri::command]
pub fn config_get(state: State<ConfigState>) -> ConfigView {
    view(&state)
}

/// Replace the rule lists, persist to config.json, return the fresh view.
// api(http PUT /api/v1/config): config_set
#[tauri::command]
pub fn config_set(
    state: State<ConfigState>,
    exclude_sites: Vec<String>,
    exclude_files: Vec<String>,
    exclude_apps: Vec<String>,
) -> Result<ConfigView, String> {
    let next = AppConfig {
        exclude_sites,
        exclude_files,
        exclude_apps,
    };
    write_file(&state.path, &next).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = next;
    *state.status.lock().unwrap() = ConfigStatus {
        source: "file".into(),
        error: None,
    };
    Ok(view(&state))
}

/// Re-read config.json from disk (for external edits).
// api(http POST /api/v1/config/reload): config_reload
#[tauri::command]
pub fn config_reload(state: State<ConfigState>) -> ConfigView {
    let (cfg, status) = read_or_default(&state.path);
    *state.config.lock().unwrap() = cfg;
    *state.status.lock().unwrap() = status;
    view(&state)
}

/// Open config.json in the default editor.
// api(shell): config_open
#[tauri::command]
pub fn config_open(state: State<ConfigState>) -> Result<(), String> {
    if !state.path.exists() {
        let cfg = state.config.lock().unwrap().clone();
        write_file(&state.path, &cfg).map_err(|e| e.to_string())?;
    }
    std::process::Command::new("/usr/bin/open")
        .arg(&state.path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}
