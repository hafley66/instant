---
created: 2026-09-20
updated: 2026-09-20
type: bug
status: testing
priority: high
---

# Large diagram preview interaction performance

## Description

## Comments

### 2026-09-20T17:32:15Z · @codex

Implemented bounded 3x SVG paint surfaces, CSS-only frame movement, diagram render caching, stale-read cancellation, Mermaid file support, bounded terminal recovery/cache retention, and large real-browser fixtures. Corrected the D2 diagnostic poll: locator.textContent waited for a removed loading element and falsely presented completed renders as 90-second stalls. Repeated fresh runs show the 701-line D2 chain completing in 2.7-3.1s. Integrated real suite passes: 6000-node SVG opens in 526ms with 16.7ms median frame batches and one viewBox write; D2 2725ms with 4212 elements; Mermaid 1670ms with 11249 elements. Full unit/check/build/cargo gates and related real browser tests pass on the integration branch. Local package: @hafley66/md@0.1.2-dev.1789923967237.

### 2026-09-20T17:32:21Z · @codex

Final combined worktree verification: 118 unit files / 764 tests, TypeScript check, build, API generator check, cargo check pass. Real-tier performance 3/3: 6000-node SVG opens526ms, interaction p50=16.7ms/max34.1ms with1 viewBox write; 701-line D2 chain compile+mount2725ms/4212 elements/0 writes; 701-line Mermaid1670ms compile+mount plus142ms object load/11249 elements/0 writes. D2 apparent hangs were test locator auto-wait after successful mount removed loading element; fixed immediate lookup and confirmed chain6/6 plus disconnected6/6 fresh runs. Local md version0.1.2-dev.1789923967237. Integrated branch fix/instant-interaction-bugs remains uncommitted and unmerged.

