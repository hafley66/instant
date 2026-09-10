// Mainline shell-outs only. Agent CLIs (claude, codex, gemini) stay off this
// list on purpose: optional, off the hot path, not worth a boot check.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// name, what stops working without it, how to install it.
const TOOLS: &[(&str, &str, &str)] = &[
    ("git", "worktrees, diffs, blob reads", "xcode-select --install"),
    ("tmux", "every terminal session", "brew install tmux"),
    ("rg", "file search and ref resolution", "brew install ripgrep"),
];

#[derive(serde::Serialize)]
pub struct ToolStatus {
    pub name: &'static str,
    pub present: bool,
    pub purpose: &'static str,
    pub install: &'static str,
}

/// Resolves against pty::path_env(), since a GUI app inherits launchd's PATH and
/// misses /opt/homebrew/bin. Reads the dir entry rather than running the binary.
fn on_path(name: &str) -> bool {
    crate::pty::path_env()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(name))
        .any(|candidate| {
            std::fs::metadata(&candidate)
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

/// Returns every tool, present ones included, so the Status panel needs no
/// second call; the boot banner filters to `!present` itself.
#[tauri::command]
pub async fn tool_status() -> Vec<ToolStatus> {
    TOOLS
        .iter()
        .map(|(name, purpose, install)| ToolStatus {
            name,
            present: on_path(name),
            purpose,
            install,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_path_finds_a_binary_every_mac_has() {
        assert!(on_path("sh"));
    }

    #[test]
    fn on_path_rejects_a_name_nobody_installs() {
        assert!(!on_path("instant-no-such-binary-9f3a"));
    }

    #[test]
    fn the_list_stays_mainline_only() {
        let names: Vec<&str> = TOOLS.iter().map(|(name, _, _)| *name).collect();
        assert_eq!(names, ["git", "tmux", "rg"]);
        for (name, purpose, install) in TOOLS {
            assert!(!purpose.is_empty(), "{name} has no purpose line");
            assert!(!install.is_empty(), "{name} has no install line");
        }
    }
}
