---
created: 2026-09-21
updated: 2026-09-21
type: bug
status: testing
priority: high
commits:
- hash: 726e5da9
  summary: hafley-rxjs fix for recursive panel activation
---

# Markdown activation recursively restores focus

## Description

The updated Markdown package crashes Instant with Maximum call stack size exceeded: focus -> MdPanelActivation.activate -> focus. Revert the app package update on main, reapply it in a worktree, and reproduce and verify focus plus Markdown rendering through the real Instant E2E harness before reintegration.

## Agent Runs

### 2026-09-22T03:49:05Z · @codex

Primary Instant main reverted and pushed at d5902476. Isolated branches: instant fix/md-focus-e2e and hafley-rxjs fix/md-focus-reentry. The real Instant renderer plus Rust backend reproduces Maximum call stack size exceeded on a Markdown heading click with package 0.1.2-dev.1790046125717. Failing trace retained in instant-md-focus-e2e/artifacts/md-focus-regression/broken-package-trace.zip. The candidate skips redundant activation for an already-active panel and guards synchronous reentry during activation/focus restoration. New full-app test passes in Chromium and WebKit, exercising heading expansion, source rendering, grid sorting, prose-width editing, keyboard focus, and panel zoom. Broader Markdown suite validation is in progress.

### 2026-09-22T03:51:26Z · @codex

Validation complete in isolated worktrees. Library fix: 726e5da9 on fix/md-focus-reentry, published only as local candidate @hafley66/md 0.1.2-dev.1790048750468. Instant regression: 2/2 pass across Chromium and WebKit. Existing Markdown suite: 10/12 passed initially; the two stale 12px typography assertions were updated to the library 13px / 1.65 rule with line-height precision normalized, then both passed. All 14 distinct full-app Markdown cases now pass. Library typecheck and focus browser test pass. Instant just check, just build, and just cargo-check pass. Reproduce using pnpm test:e2e:markdown after building the frontend and instant-serve binary; INSTANT_SERVE_BIN can point to a prebuilt backend. Primary app remains on reverted package 0.1.2-dev.1789923967237 and remote main d5902476. Candidate is not integrated into main.

