---
created: 2026-09-25
updated: 2026-09-25
type: bug
reporter: owner
status: fixed
priority: normal
closed: 2026-09-25
closed_by: claude
---

# omp sessions cannot be adopted into a tmux pane in instant

## Description

## Comments

### 2026-09-25T04:57:07Z · @claude

Cause: rogue-process discovery hardcodes two harnesses. src-tauri/src/pty.rs:1167 `if bin != "claude" && bin != "opencode"` skips every other harness binary (omp, codex, kimi), so no RogueSession exists and the tmux panel never offers adopt (src/worktrees.ts:289 adoptRogue). Fix direction: take the harness process identities from boop-harness's registry instead of the hardcoded pair; confirm omp's process name (may run under bun/node); then adoptRogue's harnessForCommand(r.command) resume path applies.

### 2026-09-25T05:06:48Z · @claude

Owner correction: adoption is a per-harness trait capability; omp's trait implements it. boop-harness already has it: LiveSessions trait (crates/boop-harness/src/live.rs:69, live_sessions() -> LiveSession{pid, cwd, tmux_pane, session_id, status}), implemented by omp at harness/omp.rs:90. Fix: instant's rogue list = every registry harness's live_sessions() filtered to tmux_pane == None (no ps scan, no binary list); delete the hardcoded claude/opencode scan at src-tauri/src/pty.rs:1148-1175; adoptRogue resumes via the harness's resume_id (harness.rs:728).

### 2026-09-25T12:51:25Z · @claude

hafley-rs 6ed4070a boop_harness::live::off_tmux_sessions (every registry's LiveSessions, tmux_pane None, root scope, pid tty outside tmux pane ttys; test off_tmux_sessions_come_from_every_harness_registry_not_a_binary_list). instant 2323f384 rogue_agent_sessions uses it; adoptRogue resumes the reported session_id. cargo check + tsc + api:check pass.


