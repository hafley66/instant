---
created: 2026-10-03
updated: 2026-10-03
type: bug
status: fixed
priority: high
closed: 2026-10-03
closed_by: codex
---

# Restore turn feed and exact chat file lookup

## Description

Instant links schema-38 sibling code against the schema-40 live store. Turn projections fail. Cmd-click chooses recent cwd sessions instead of the exact pane chat and misses touched repository worktrees. Pin local registry packages from current main and verify the dev path.

## Comments

### 2026-10-03T14:15:57Z · @codex

Schema 40 consumer queries repaired; favorite deletion uses favorite_delete by ID. Pane-owned attribution survives sidebar closure, and idle chat bindings trigger ingestion. Exact clicked chat resolves its touched repository worktrees. Local live probe projects squares, resolves the reported HTML, and adds/removes an assistant favorite without leaving a test favorite. Boop click tests: 10 passed; boop-xterm suite: 184 passed before restoring the existing feed test, then 4 targeted tests passed; search integration: 3 passed, 1 ignored. Typecheck, web build and native build passed. Dev-safe startup and final cargo-check in progress.

## Resolution

### 2026-10-03T14:20:03Z · @codex

All required gates passed: just check, just build, just cargo-check. just dev-safe booted the native app and Vite frontend. Browser smoke opened a viewer of the actual affected Claude pane: visible turn sidebar, no page errors. Live backend verification resolved the reported HTML and persisted then removed an assistant favorite. Kellnr remains on 8000, viewer moved to 8001, Verdaccio serves pinned boop-xterm. Existing unrelated edits preserved.
