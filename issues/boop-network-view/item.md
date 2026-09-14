---
created: 2026-09-13
updated: 2026-09-14
type: bug
status: open
priority: high
---

# Fix blank Boop network view

## Description

User reports blank network view, suspects slow query and an unmerged worktree fix. Recover prior scoped-network work, trace query costs, reproduce with synthetic SQLite and actual network rendering.

## Resolution

### 2026-09-14T01:16:32Z · @codex

Integrated paired boop-store 161f13a and Instant network fix plus final waterfall test 454fc540 into main. Parent main validation: network 5/5, lifecycle 7/7, store 14/14, just check/build/cargo-check pass; rebuilt instant-serve from main. Final synthetic 1200 sessions/1200 lanes/120000 turns/12000 events: RPC 350ms, visible rows 992ms. Trace defaults preserved; Instant explicitly skips unused trace reads. Configured tmux socket passed to liveness probes. Daily-driver restart/rebuild still required to load Rust changes. Global durable-query history scope remains a separate limitation. Both task worktrees and branches removed.

## Reopen Notes — 2026-09-14

_Add rationale for reopening here._

## Comments

### 2026-09-14T11:50:22Z · @codex

Reopened from user screenshot on 2026-09-14: Boop tab displays no agents in the window despite open terminal tabs. Earlier synthetic tests and query-speed fix do not establish resolution of this live symptom. Investigate query start/subscription, pending versus successful-empty state, projection filters and running native build. Worker fix-boop-empty-live uses source and isolated SQLite/Playwright; parent inspects live process locally.

### 2026-09-14T12:14:11Z · @codex

Implemented and pushed: hafley-rs cc0c4e03 adds schema v32 covering agent_turn(session_id,ts) index; installed Boop cc0c4e03 and ran the normal Store::open migration on the live store after a local backup. Parent exact SESSION_GRAPH_SQL read-only timing: 5802 rows in 6.938s before; same row count in 0.117s and 0.114s after, EXPLAIN uses COVERING INDEX idx_turn_session_ts. Instant cab6513d + 8519295d separate loading/error/filtered-empty/successful-empty and put the state above the blank table area. Parent check/build/cargo-check passed; real isolated SQLite+Playwright lifecycle 9/9 including a held read, release to rows and refocus. Worker network 5/5, state tests 7/7 and pre-fix negative control failed as expected. Source sampled live native process inside session SQL before the migration. Remains open pending confirmation that the owner window now populates; async user question sent. Separate source-only release socket discrepancy retained in @graph-release-socket.

