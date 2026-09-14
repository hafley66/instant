---
created: 2026-09-14
updated: 2026-09-14
type: bug
status: fixed
priority: normal
related: ['@boop-network-view']
closed: 2026-09-14
closed_by: codex
---

# Keep Boop roster and timeline rows readable and consistent

## Description

User confirms rows now appear after the activity-index migration, but screenshot shows confusing layout. Current boopPanel filters roster roots with boopOnlyActive while the lower marbler source derives from all lanes through subtreeLanes, so the two panes list different row sets. Timeline labels use raw route/session identifiers, repeated truncated session prefixes are hard to distinguish, and events sit against the right edge while the timeline occupies a large mostly empty area. Preserve stored identities and graph semantics; coordinate presentation filtering/order, readable identity labels and event-window controls using existing grid/marbler libraries. User preference requested: one aligned roster+timeline versus retained split panels. No layout choice approved yet; data-loading incident is resolved separately.

## Comments

### 2026-09-14T12:17:53Z · @codex

User clarified: retain split panels; show only active agents and only descendants that are also active, with a timeline scrubber. Supersedes the earlier open-tabs versus all-live question. Apply one active predicate to both panels recursively rather than retaining inactive children beneath live roots. Check GraphSession.state mapping (current renderer assigns session nodes idle unless finished), preserving backend liveness semantics instead of substituting timestamp recency. Reuse existing marbler navigator/scrubber and grid stack.

### 2026-09-14T12:19:31Z · @codex

Final preference confirmed: all live agents, collapsed by default; retain split panels; expanding shows only live descendants; timeline scrubber required. Worker fix-boop-active-timeline started from fb592022 with shared active filtering, backend state mapping, frame-based viewport domain and reusable navigator scope. Private owner data excluded from delegation.

## Resolution

### 2026-09-14T12:52:06Z · @codex

Implemented all live agents collapsed by default in retained split panels. The active projection removes inactive descendants and promotes live grandchildren; controlled expansion drives both roster and timeline membership. Selecting a root retains subtree inspection. Session live state takes precedence over historical finished timestamps. The timeline uses mail-frame time bounds and preserves the paused interval through refocus and new mail. Tracked marbler dependency patch exports the existing reducer for follow/fit and adds a 160px scrolling navigator without clipping canvas coordinates. Parent validation: just check/build/cargo-check PASS; focused Vitest 33/33; real isolated SQLite Playwright network 8/8 and lifecycle 9/9, including full-interval refocus equality and dense last-row hover. Worker full Vitest 708/708. Product commits 778fe66a,13562dd3,ae6e9633; parent strengthened regression 7a350492. Synthetic screenshots in artifacts/real/boop-network-06..08.
