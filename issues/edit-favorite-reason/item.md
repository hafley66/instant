---
created: 2026-09-14
updated: 2026-09-14
type: feature
status: open
priority: normal
---

# Edit an existing Boop favorite reason

## Description

Cleanup audit 2026-09-14: current main already creates favorites with notes through favoriteBoopTurn(note), askText and candidateSessions. The unshipped part of feature/boop-reminders-instant at f7a647fd5bdce3761068b9ac5585fd8a6454ec31 is boop_favorite_edit, editBoopFavoriteReason, the Favorite reason menu action and its real browser/native tests. Preserve this specific behavior; do not replay the old full branch over current main. Source-only audit, no new test pass claimed. Existing source is retained in /Users/chrishafley/projects/instant-worktrees/boop-reminders-instant-integration/instant until a scoped port is scheduled.

## Comments

### 2026-09-14T14:00:13Z · @codex

Cleanup final: the original worktree is now removed. Recover the candidate from archive/boop-cleanup-20260914/feature/boop-reminders-instant at f7a647fd5bdce3761068b9ac5585fd8a6454ec31. Preserve only editing an existing favorite reason; note creation, tags, askText and candidate-session handling already exist on main. Archive refs are local.
