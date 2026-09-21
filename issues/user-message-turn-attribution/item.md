---
created: 2026-09-21
updated: 2026-09-21
type: bug
status: testing
priority: high
commits:
- hash: 21df0994
  summary: preserve marked user turns and favorite coverage
---

# Track user-message turns for favorites and remind

## Description

Instant omits user-message rows from terminal turn attribution, so user rows lack the favorite action. The boop CLI needs remind N to read the last N user messages from the invoking tracked session through the shared turn ledger, with deterministic chronology and no cwd inference.

## Agent Runs

### 2026-09-21T18:03:39Z · @codex

Implemented terminal user-turn attribution priority and favorite coverage in the authorized turn-remind worktree. The matcher preserves marked user prompts when an assistant row quotes the same text, and favoriteBoopTurn coverage accepts user-role turns.
