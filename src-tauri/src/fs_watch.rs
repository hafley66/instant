use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct FsWatchClaims(pub Mutex<HashMap<String, RecommendedWatcher>>);

impl Default for FsWatchClaims {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsWatchEvent {
    claim_id: String,
    path: String,
    kind: String,
}

fn event_matches(event: &Event, target: &Path, target_is_dir: bool) -> bool {
    event.paths.iter().any(|path| {
        if target_is_dir {
            path.starts_with(target)
        } else {
            path == target
        }
    })
}

#[tauri::command]
pub fn fs_watch_claim(
    app: AppHandle,
    state: State<FsWatchClaims>,
    claim_id: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let target = crate::fs::resolve(Some(path));
    let target = target.canonicalize().unwrap_or(target);
    let target_is_dir = target.is_dir();
    let watch_root: PathBuf = if target_is_dir {
        target.clone()
    } else {
        target
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", target.display()))?
            .to_path_buf()
    };
    let callback_target = target.clone();
    let callback_claim_id = claim_id.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else { return };
        if !event_matches(&event, &callback_target, target_is_dir) {
            return;
        }
        let payload = FsWatchEvent {
            claim_id: callback_claim_id.clone(),
            path: callback_target.to_string_lossy().into_owned(),
            kind: format!("{:?}", event.kind),
        };
        let _ = app.emit("fs-watch", payload);
    })
    .map_err(|error| error.to_string())?;
    let mode = if target_is_dir && recursive.unwrap_or(false) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(&watch_root, mode)
        .map_err(|error| format!("{}: {error}", watch_root.display()))?;
    state
        .0
        .lock()
        .map_err(|_| "filesystem watch claims lock poisoned".to_string())?
        .insert(claim_id, watcher);
    Ok(())
}

#[tauri::command]
pub fn fs_watch_release(state: State<FsWatchClaims>, claim_id: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "filesystem watch claims lock poisoned".to_string())?
        .remove(&claim_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};
    use notify::EventKind;

    fn event(path: &str, kind: EventKind) -> Event {
        Event::new(kind).add_path(PathBuf::from(path))
    }

    #[test]
    fn file_claim_matches_only_the_claimed_path() {
        let changed = event("/docs/book.md", EventKind::Modify(ModifyKind::Any));
        let sibling = event("/docs/other.md", EventKind::Modify(ModifyKind::Any));
        assert!(event_matches(&changed, Path::new("/docs/book.md"), false));
        assert!(!event_matches(&sibling, Path::new("/docs/book.md"), false));
    }

    #[test]
    fn directory_claim_matches_the_root_and_descendants() {
        let direct = event("/docs/book.md", EventKind::Create(CreateKind::File));
        let nested = event("/docs/guide/intro.md", EventKind::Create(CreateKind::File));
        let outside = event("/other/intro.md", EventKind::Create(CreateKind::File));
        assert!(event_matches(&direct, Path::new("/docs"), true));
        assert!(event_matches(&nested, Path::new("/docs"), true));
        assert!(!event_matches(&outside, Path::new("/docs"), true));
    }
}
