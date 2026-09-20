---
created: 2026-09-20
updated: 2026-09-20
type: bug
status: testing
priority: high
---

# Closing an exited tmux pane changes another pane viewport

## Description

User reports viewport changes in unrelated panes introduced by fix(pty): reap a dead tmux pane when its tab closes (10ada635). Investigate after preview and annotation work. Use local Verdaccio and local Rust registry for dependency changes.

## Comments

### 2026-09-20T17:23:43Z · @codex

Reproduced on private tmux socket with a 120x40 two-pane window: dead pane 60x40, live sibling 59x40, then kill-pane expanded the sibling to 120x40. Root cause is tmux layout reflow from removing a dead pane in a shared window; removing the last pane of another window can also change an attached client selection. Implemented fix on fix/tmux-closing-regression: resolve the exact pane ID and reap only when pane_dead=1, window_panes=1, and session_windows=1. Shared layouts remain intact. Added generated reap_dead_target IPC schema entry. Focused private-socket tests pass 2/2; just cargo-check and api:check pass.

### 2026-09-20T17:28:17Z · @codex

Parent integration review added window_linked=0 guard so linked/grouped sessions retain their windows, and replaced fixed sleeps with bounded pane_dead polling. Setup errors now fail the new tests. Private socket tests passed: shared sibling dimensions preserved, linked dead pane retained, isolated dead session removed.

