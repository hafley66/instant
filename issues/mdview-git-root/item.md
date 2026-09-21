---
created: 2026-09-21
updated: 2026-09-21
type: task
status: testing
priority: high
commits:
- hash: 21df0994
  summary: expose repo_root IPC and markdown host bridge
---

# Expose Git root metadata to markdown panels

## Description

## Agent Runs

### 2026-09-21T17:39:26Z · @codex

Implementation receipt: added the repo_root IPC command and markdown host bridge. The command accepts file paths by walking from the file's parent, while the shared ReadPathArgs type handles RPC decoding. Focused refresolve coverage verifies file-path lookup.

### 2026-09-21T18:07:01Z · @codex

Pinned-dependency validation: just check, just build, and just cargo-check pass in the isolated integration worktree after adding the repo_root IPC command and typed markdown host bridge.
