---
created: 2026-09-20
updated: 2026-09-20
type: bug
status: testing
priority: high
---

# Boop-revived Codex chat loses turn attribution

## Description

A Codex chat revived through Boop no longer maps its visible transcript turns to the Boop session, so Instant turn attribution fails. Trace revived session identity, process mapping, and transcript lookup; add a deterministic regression.

## Comments

### 2026-09-20T18:04:38Z · @codex

Root cause proven in boop-harness CodexDoor::tui_launch: explicit `resume <thread>` was parsed and forwarded to the TUI, but NativeTuiPlan.session_id was initialized to None. The revived wrapper therefore overwrote its route with session_id:null until an optional later app-server selection event. Instant boop_mux_session could not resolve the pane conversation, so exact boop turn lookup and attribution were bypassed. Fix seeds plan.session_id from the explicit requested thread. Socket-backed regression failed before with None versus the thread ID and passes after; full boop-harness library suite passes 222 tests with 2 ignored. Existing running wrappers need a later safe restart/revive after the updated boop binary is installed; no live chat was killed.

### 2026-09-20T18:07:40Z · @codex

Recovery audit: all four currently live Codex routes now carry non-null exact session IDs. The revived wrapper command line retains its explicit `resume <thread>` ID, but there is no wrapper refresh/rebind IPC. `lane patch --session-id` can edit the registry, while the running wrapper may overwrite that edit from its cached route on a later native event. No live route was mutated or restarted. The installed binary remains commit 22fdedaa until the tested fix is built from that lineage; installing a replacement affects future wrappers and leaves existing processes running.

### 2026-09-20T18:09:15Z · @codex

Verified and committed fix d3b39885 on hafley-rs main, merged latest origin/main to preserve installed22fdedaa behavior, published b9975337 under guarded install workflow. Locked boop-harness gate:222 passed2 ignored. Installed signed boop0.0.10(b9975337) atomically; backup /private/tmp/boop-22fdedaa-backup-zl4num6d. No running wrapper stopped. Current live route identities are non-null; further read-only attribution-path verification ongoing for the reported existing chat.

### 2026-09-20T18:13:42Z · @codex

Persistent affected instance identified as `codex-20` on pane `%4`. The old Instant RPC resolved `%4` to a detached OMP session with 144 stored turns even though the live Codex route bound `%4` to its resumed session. The OMP tty breadcrumb survived its prior TUI and the tty was reused by Codex; generic harness discovery ran before the exact live route and shadowed it. The lookup fix gives precedence only to a route whose `agent_live` row records the same pane and an alive PID, preserving harness discovery and the prior route fallback for all other cases. Two deterministic regressions and the full boop-harness library suite pass (224 passed, 2 ignored). No transcript or live chat was mutated.

### 2026-09-20T18:18:20Z · @codex

Persistent reported case verified and fixed: codex-20 pane%4 was incorrectly resolved to staleOMP01a0b6e0 (144turns). Validated route precedence now checks matchingpane and livefrontendPID before nativebreadcrumbs. Locked boop-harness tests224pass2ignored. Rebuilt Instant backend read-onlyRPC against actual%4 returned Codex01a0bb9d-cbbd-7bd2-9202-06d38d6f53af and301 homogeneous turns. Fix committed/pushed hafley-rs/main0080597a and signed boop0.0.10(0080597a) installed atomically. Same live.rs patch applied to originalhafley-rs pathdependency consumedby./instant. No chat/desktopprocess stopped; temporaryverificationserver stopped. Existing desktopprocess may require normal devreload to load updatedRust.

### 2026-09-20T18:43:09Z · @codex

CI follow-up: hafley-rs boundary guard found Claude summary dispatch inside generic boop-turnvis. Sequential Luna lane 1 moved the grammar and anchoring into boop-harness, with a generic callback seam. Instant companion worktree instant-ci-luna/instant migrates both production matcher callers to retain collapsed-tool attribution. Targeted harness, turnvis, turnstrip and screen tests pass; companion application checks are underway. Main and the running app remain unchanged during verification.

### 2026-09-20T19:09:33Z · @codex

Sequential follow-up completed with four GPT-5.6 Luna high agents and parent diff review. hafley-rs main ecd522e7 fixes the four known CI failures: Claude summary ownership, missing OMP mock recipe, per-harness typed readiness, and shared fixture isolation. Instant companion 4d4e2111 preserves both existing matcher callers. Combined boundary (2), live-harness recipe/submission (3), isolation rail (2), command environment (1), and Claude summary (1) tests pass, as do turnvis/turnstrip suites and boop no-default-features check. Real OMP fixture passes against loopback llmock on its private tmux socket, including distinct sessions, dead-pane lookup and resume. Instant check/build/cargo-check, 8 square tests and locator golden test pass; final cargo-check in ./instant also passes. hafley-rs pushed; Instant push follows. Existing app process was not restarted.






