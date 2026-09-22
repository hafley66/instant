---
created: 2026-09-21
updated: 2026-09-21
type: task
status: testing
priority: high
---

# Refresh Markdown packages from main through local registry

## Description

Update local main checkouts, publish current md and its changed library dependencies to Verdaccio, install exact development versions in Instant, and verify the existing dev runtime plus Verdaccio and Kellnr health.

## Agent Runs

### 2026-09-22T03:07:06Z · @codex

Updated Instant main from 442e713c to 0a790040 and hafley-rxjs main to b0b66859 while preserving local work. Published md 0.1.2-dev.1790046125717, signal-grid 0.1.0-dev.1790046174244, xdom 0.1.0-dev.1790046173930, and trace 0.1.0-dev.1790046122144 to local Verdaccio. Exact pins installed in Instant; source package versions remain unchanged. Existing diagram bundling retained via LOCAL_MD_BUNDLE=1. Gates: just check, just build, just cargo-check; 41 Instant tests; 13 Markdown model tests and 13 browser tests. Installed-package browser smoke through the existing Vite server rendered beta/2, alpha/1 and sorted to alpha/1, beta/2 with zero page errors. Vite config watcher refreshed the dependency graph while the original just dev process remained running. Verdaccio port 4873 and Kellnr port 8000 returned HTTP 200. hafley-rs main worktree includes current origin/main; primary feature checkout with uncommitted work preserved.
