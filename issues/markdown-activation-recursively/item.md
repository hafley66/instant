---
created: 2026-09-21
updated: 2026-09-22
type: bug
status: testing
priority: high
commits:
- hash: 726e5da9
  summary: hafley-rxjs fix for recursive panel activation
- hash: 0bf1e7c5
  summary: Instant double-revert worktree and real-app Markdown E2E coverage
---

# Markdown activation recursively restores focus

## Description

The updated Markdown package crashes Instant with Maximum call stack size exceeded: focus -> MdPanelActivation.activate -> focus. Revert the app package update on main, reapply it in a worktree, and reproduce and verify focus plus Markdown rendering through the real Instant E2E harness before reintegration.

## Agent Runs

### 2026-09-22T03:49:05Z · @codex

Primary Instant main reverted and pushed at d5902476. Isolated branches: instant fix/md-focus-e2e and hafley-rxjs fix/md-focus-reentry. The real Instant renderer plus Rust backend reproduces Maximum call stack size exceeded on a Markdown heading click with package 0.1.2-dev.1790046125717. Failing trace retained in instant-md-focus-e2e/artifacts/md-focus-regression/broken-package-trace.zip. The candidate skips redundant activation for an already-active panel and guards synchronous reentry during activation/focus restoration. New full-app test passes in Chromium and WebKit, exercising heading expansion, source rendering, grid sorting, prose-width editing, keyboard focus, and panel zoom. Broader Markdown suite validation is in progress.

### 2026-09-22T03:51:26Z · @codex

Validation complete in isolated worktrees. Library fix: 726e5da9 on fix/md-focus-reentry, published only as local candidate @hafley66/md 0.1.2-dev.1790048750468. Instant regression: 2/2 pass across Chromium and WebKit. Existing Markdown suite: 10/12 passed initially; the two stale 12px typography assertions were updated to the library 13px / 1.65 rule with line-height precision normalized, then both passed. All 14 distinct full-app Markdown cases now pass. Library typecheck and focus browser test pass. Instant just check, just build, and just cargo-check pass. Reproduce using pnpm test:e2e:markdown after building the frontend and instant-serve binary; INSTANT_SERVE_BIN can point to a prebuilt backend. Primary app remains on reverted package 0.1.2-dev.1789923967237 and remote main d5902476. Candidate is not integrated into main.

## Comments

### 2026-09-22T04:16:39Z · @codex

Follow-up: reduce Markdown gutters, cell padding and section gaps; truncate section and table headers with full-text title tooltips. Verify in the isolated full-app E2E worktree.

### 2026-09-22T04:18:58Z · @codex

Dense Markdown follow-up verified: Chromium and WebKit full-app cases pass, both page-error receipts are []. Checked actual overflowing table label, ellipsis, full-text title attributes, 3px vertical/6px horizontal cell padding, sorting and focus/zoom. Persistent screenshots: instant-md-focus-e2e/artifacts/md-focus-regression/dense-webkit-markdown-focus.png and dense-chromium-markdown-focus.png. Library typecheck, Instant check and build passed. Changes remain in isolated worktrees.

### 2026-09-22T05:25:41Z · @codex

Integration: hafley-rxjs main fast-forwarded to 41174980 with focus guard, compact 28px table density, vertical centering, ellipsis and tooltips. Instant additionally exempts every md-body code/pre descendant from Super XP bitmap fonts; full browser suite includes inline-code verification.

### 2026-09-22T05:30:42Z · @codex

Final validation: all 12 existing Markdown cases passed; both updated focus/density/inline-Super-XP cases passed after synchronizing the existing terminal 60ms focus callback. Page-error receipts empty. Instant check, build and cargo-check pass. Ready for main integration.



