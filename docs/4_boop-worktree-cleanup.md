# Boop worktree cleanup, 2026-09-14

Removed 18 old instant worktrees and their local branches. Across both repositories: 57 worktrees, plus the two temporary audit workers. Three stale historical worker routes were removed.

No historical product patch was merged during cleanup. Main has concurrent work from other sessions; it was left untouched. The ghcache integration worktree, unrelated labs and shared build caches were excluded.

## Retained work

The following source remains pending behind explicit issues. Archive refs are local Git tags; they were not published. WIP refs contain complete archival commits including formerly untracked source, with no test-pass claim.

| Feature | Issue | Source ref |
| --- | --- | --- |
| Edit existing favorite reason | [edit-favorite-reason](../issues/edit-favorite-reason/item.md) | `archive/boop-cleanup-20260914/feature/boop-reminders-instant` |
| Terminal-scoped network integration | [instant-feature-atlas](../issues/instant-feature-atlas/item.md) | `archive/boop-cleanup-20260914/chore/f41-final-integration-20260912` |

## Removed checkouts

Shipped or superseded variants were removed after ancestry, patch-equivalence or source review. Historical variants that were not proved identical retain their exact source tags; removal does not claim that every hunk is already shipped.

| Old branch | Preserved source | Disposition |
| --- | --- | --- |
| `fix/instant-boop-selection-ui` | `dfe68b74535d1858c433e92a8bfd5a8cdf83b6aa` | shipped or superseded |
| `fix/markdown-terminal-replay` | `archive/boop-cleanup-20260914/fix/markdown-terminal-replay` | shipped or superseded |
| `research/terminal-replay-prior-art` | `archive/boop-cleanup-20260914/research/terminal-replay-prior-art` | shipped or superseded |
| `fix/boop-selection` | `65db65bb9361ce3278773f27c684aab3f8f7b54d` | shipped or superseded |
| `fix/diagram-viewport-reset` | `c5f5a6b712037e2aae9384cff75cccee95ec86b6` | shipped or superseded |
| `fix/fork-interactive` | `dfe68b74535d1858c433e92a8bfd5a8cdf83b6aa` | shipped or superseded |
| `chore/f41-independent-review-20260912` | `archive/boop-cleanup-20260914/chore/f41-independent-review-20260912` | shipped or superseded |
| `refactor/harness-store-dedupe` | `a1a27b0a65377101684957446e4ed2c5c23afa87` | shipped or superseded |
| `feature/boop-turn-visibility-v2` | `8ed7b77ea603650946befbcf35b0c5526b37b7fc` | shipped or superseded |
| `fix/f41-scoped-network-20260912` | `archive/boop-cleanup-20260914/fix/f41-scoped-network-20260912` | shipped or superseded |
| `test/f41-isolation-red-20260912` | `archive/boop-cleanup-20260914/test/f41-isolation-red-20260912` | shipped or superseded |
| `fix/turn-attribution-input-traits` | `archive/boop-cleanup-20260914/fix/turn-attribution-input-traits` | shipped or superseded |
| `fix/luna-scoped-network-20260912` | `archive/boop-cleanup-20260914/fix/luna-scoped-network-20260912` | shipped or superseded |
| `fix/instant-origin-family-reconcile-terra` | `archive/boop-cleanup-20260914/fix/instant-origin-family-reconcile-terra` | shipped or superseded |
| `docs/book-pages` | `4487f3ffd7c235f564e6d4aa88b410c3187ff302` | shipped or superseded |
| `feature/boop-reminders-instant` | `archive/boop-cleanup-20260914/feature/boop-reminders-instant` | kept-pending-feature |
| `chore/f41-final-integration-20260912` | `archive/boop-cleanup-20260914/chore/f41-final-integration-20260912` | kept-pending-feature |
| `chore/luna-app-atlas-20260912` | `archive/boop-cleanup-20260914/chore/luna-app-atlas-20260912` | superseded |

## Recovery and verification

Local archive: `/Users/chrishafley/projects/boop-cleanup-20260914/`. Its README explains recovery; the action ledger records exact heads, refs, dirty snapshots and removal evidence. The archive contains source and metadata, with no private Boop database copy.

Verification checked all 57 removed paths and branch refs, plus all 46 archive refs in the action ledger. No product tests were run during this source-and-Git cleanup. The npm cache pin, turn-lineage/composer exclusion, and favorite-note creation were confirmed in current shared implementations and were not reintroduced from old worktrees.
