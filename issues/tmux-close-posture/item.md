---
created: 2026-09-26
updated: 2026-09-26
type: bug
status: open
priority: normal
---

# Closing tmux tabs leaves bad state for the next new tab

## Description

## Report
Closing tmux-backed tabs (reporter exits the TUI, then types `exit` so the tab close ends the pane), then opening a new tab, misbehaves. The exact symptom is not yet recorded; ask the reporter.

## Wanted: clean tmux posture on close
On tab close, classify the pane generically from tmux formats plus the process tree:

| field | source |
| --- | --- |
| pane id, pid, dead | `#{pane_id} #{pane_pid} #{pane_dead}` |
| foreground command | `#{pane_current_command}` |
| cwd | `#{pane_current_path}` |
| siblings | `#{window_panes} #{session_windows} #{session_attached}` |
| children of the shell | `pgrep -P <pane_pid>` (none means idle) |

A pane is *idle* when its current command is a login shell (bash, zsh, fish, sh) and the shell pid has no children.

| pane state on close | action |
| --- | --- |
| dead | kill pane (existing `reap_dead_target`, `pty.rs:982`) |
| idle shell, sole pane/window, no other client attached | record cwd, kill session |
| idle shell sharing a window/session | record cwd, kill pane only |
| running a process (agent, build, editor) | leave it; the tab close only detaches |

## Acceptance Criteria
- [ ] Symptom recorded and reproduced by a test.
- [ ] Close classifies panes with the table above; one Rust function returns the state from a single `display-message` call plus the child check.
- [ ] No idle-shell tmux sessions are left behind after closing tabs.
- [ ] Unit test for the classifier over each state; e2e against a real tmux server on a scratch socket.

## Comments

### 2026-09-26T15:07:14Z · @claude-397

Symptom (reporter): after closing tmux tabs, a new tab attaches to a session already open in another tab. tmux dots fill the unused area and the two tabs flicker as their clients fight over the window size.
Cause: openTabAtPwd (src/tabs.ts:188-202) picks the next free name against store.sessions (polled, can be stale) and tab names. pty.rs:674 runs 'tmux new-session -A -D -s <name>'; -A attaches to an existing session with that name instead of failing.
Fix direction: a new tab never attaches. Allocate the name against a live 'tmux list-sessions -F #{session_name}' plus every open tab's tmux target session. Create without -A, so a collision fails with 'duplicate session' and retries the next suffix. Keep -A only for explicit reattach and reopen paths.
AC add: a test opens two new tabs after closing one whose session survived; each tab gets its own session and each session has exactly 1 client.
