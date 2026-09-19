---
created: 2026-09-18
updated: 2026-09-18
type: bug
status: open
priority: high
---

# Closing a tab leaks its tmux pane when the pane is already dead

## Description

## Description

Closing a tab whose tmux pane is already dead leaks the pane. It stays in the tmux server forever, unreferenced by the UI.

Four leaked panes were live on this machine when the defect was found: `ascii-renderer`, `projects-11`, `shell`, `sprefa-2`, all `#{pane_dead}=1`.

## Causal chain

1. `open_session` sets `remain-on-exit on` for every session instant owns (`src-tauri/src/pty.rs:438`). A process that exits leaves a dead pane instead of closing the window. This is deliberate: it feeds the `respawn-pane -k` revive at `pty.rs:443-458`.
2. Closing a tab runs `onTermClosed` (`src/terminal.ts:1382`), whose only backend call was `close_pty` (`:1431`).
3. `close_pty_impl` for a tmux tab has `child == None` (`pty.rs:713-721`), so it drops the pty master and detaches. Nothing tmux-side runs.
4. `forgetTab(id)` removes the row from `settings.openTabs`, so next boot never reattaches it. The pane is now unreachable from the UI.

No liveness check ran on the close path. The one `#{pane_dead}` read lives in `enable_mouse` at open time and answers a dead pane by respawning it.

## Second defect: no verb could kill a pane

`kill_session` is keyed by session name (`pty.rs:993,1010`), `PtyHandle` does not store `tmuxTarget` (`pty.rs:37-46`), and `kill-pane` appeared nowhere in the repo. Viewer and lane tabs carry a `%NNN` target, so they could only ever be detached.

## Third defect: the proc column was blank for omp

`harness_command` (`pty.rs:356-365`) matched `claude`, `ccz`, `codex`, `opencode`, `kimi`. It did not match `omp`, so every omp lane showed a blank `proc` in the session table.

## Fix applied

| file | change |
|---|---|
| `src-tauri/src/pty.rs` | new `reap_dead_target(target)`: reads `#{pane_dead}`, kills the pane only when `1`. async plus `spawn_blocking`, so no main-thread shell-out |
| `src-tauri/src/pty.rs` | `omp` added to `harness_command` |
| `src-tauri/src/lib.rs` | registered for the app |
| `src-tauri/src/serve/rpc.rs` | mirrored for the headless binary |
| `src/terminal.ts` | `onTermClosed` chains `reap_dead_target` after `close_pty` |

A live pane still detaches for reattach. Only a dead one is reaped.

## Tests Run

- [x] `cargo check` exit 0
- [x] `npx tsc --noEmit` exit 0
- [x] `cargo test --lib pty` 22 passed, 0 failed

## Acceptance Criteria

- [x] Closing a tab over a dead pane reaps it
- [x] Closing a tab over a live pane still detaches only
- [x] A pane id target (`%NNN`) can be killed
- [x] omp shows in the proc column
- [ ] Change committed
