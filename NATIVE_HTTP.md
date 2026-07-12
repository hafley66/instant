# Native transport migration

Generated from structured comments beside Rust commands. Run `just native-http`
after changing an `api(...)` declaration.

The implementation and rollout plan is in `docs/PLAN-native-http.md`.

Network operations enter OpenAPI before frontend migration. `shell` operations
remain Tauri capabilities because they control the desktop shell itself.

## Network operations

<!-- BEGIN: native-http -->
- [api(http DELETE /api/v1/worktrees): remove_worktree](src-tauri/src/worktrees.rs#L113)
- [api(http GET /api/v1/config): config_get](src-tauri/src/config.rs#L180)
- [api(http GET /api/v1/worktrees): scan_worktrees](src-tauri/src/worktrees.rs#L166)
- [api(http GET /api/v1/worktrees/diff): git_diff](src-tauri/src/worktrees.rs#L86)
- [api(http POST /api/v1/config/reload): config_reload](src-tauri/src/config.rs#L210)
- [api(http POST /api/v1/worktrees): add_worktree](src-tauri/src/worktrees.rs#L62)
- [api(http PUT /api/v1/config): config_set](src-tauri/src/config.rs#L187)
<!-- END: native-http -->

## Desktop-shell capabilities

<!-- BEGIN: native-shell -->
- [api(shell): config_open](src-tauri/src/config.rs#L220)
<!-- END: native-shell -->
