---
created: 2026-09-26
updated: 2026-09-26
type: bug
status: open
priority: normal
related: ['@tmux-close-posture']
---

# Reopen closed tab works generically, reopening at the last cwd

## Description

## Report
Reopen closed tab (`reopenLastTab`, `tabs.ts:147`, Cmd+Shift+T) must work for every tab kind and every close path, including a pane that ended because its shell exited.

## Wanted
- Every close records a reopen entry: tab kind, title, `pane_current_path` read before the kill, tmux target if the pane survives, and harness plus session id if an agent ran there.
- Reopen resolves in order:
  1. The pane is still alive: reattach.
  2. An agent session id is recorded: resume through `boop tui <harness> -- --resume <id>`.
  3. Otherwise: a new shell tab at the recorded cwd.
- Terminal, file preview, browser and graphics tabs all go through the same entry record.

## Acceptance Criteria
- [ ] Reopen after `exit` opens a shell at the last cwd.
- [ ] Reopen after closing a live agent tab resumes it (registered with boop).
- [ ] Reopen of a file or browser tab is unchanged.
- [ ] Tests per tab kind; one e2e on a real tmux scratch socket.
