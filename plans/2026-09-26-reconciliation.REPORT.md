# Reconciliation inventory: instant, hafley-rxjs, hafley-rs (2026-09-26)

Read-only snapshot. Nothing merged, deleted or rebased.
`merge` column = `git merge-tree --write-tree main <ref>`; `cherry +/-` = `git cherry main <ref>` (all `-` means every patch already on main).

Buckets: `merge-ready` (clean, new content, ≤14 days), `merge-ready-old` (clean, new content, >14 days), `conflicts`, `stale-wip` (tip is a wip snapshot >14 days old), `superseded` (every cherry `-`), `dirty-only` (worktree edits, 0 commits ahead), `primary-owned` (the cutover, handled elsewhere), `clean-noop` (worktree clean and 0 ahead).

## Summary

| repo | merge-ready | merge-ready-old | conflicts | stale-wip | superseded | dirty-only | primary-owned | clean-noop | main uncommitted files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| instant | 1 | 0 | 10 | 12 | 12 | 13 | 1 | 10 | 41 |
| hafley-rxjs | 0 | 3 | 38 | 0 | 7 | 8 | 0 | 26 | 91 |
| hafley-rs | 10 | 4 | 53 | 0 | 39 | 7 | 0 | 48 | 97 |

Main uncommitted counts use `git status --porcelain -uall` (untracked directories expanded), so they exceed the per-entry counts from the earlier board (instant 30, hafley-rxjs 52, hafley-rs 94).

## instant

| bucket | branch | worktree | ahead | dirty | last commit | merge | cherry +/- | diff | what |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| merge-ready | `fix/omp-rendered-e2e-terra` | `~/projects/instant/.boop-worktrees/fix/omp-rendered-e2e-terra` | 1 | 1 | 2026-09-15 test: cover real OMP rendered attribution | clean | 1/0 | 4f, 232+ | test: cover real OMP rendered attribution |
| conflicts | `wip/md-table-fit` | `—` | 5 | 0 | 2026-09-25 WIP(e2e): md table fit under instant's real cascad | conflicts(3) | 1/4 | 8f, 415+, 31- | WIP(e2e): md table fit under instant's real cascade at DPR 2 (items 6/ (+4 more) |
| conflicts | `wip/main-checkout-20260918` | `—` | 1 | 0 | 2026-09-18 wip: park main-checkout edits before trunk update | conflicts(10) | 1/0 | 66f, 3180+, 114- | wip: park main-checkout edits before trunk update |
| conflicts | `chore/tauri-condom-scratch` | `—` | 1 | 0 | 2026-09-07 scratch: native wdio fork spec, PNGs, briefs (kept | conflicts(1) | 1/0 | 8f, 345+, 1- | scratch: native wdio fork spec, PNGs, briefs (kept for reference) |
| conflicts | `test/native-webview-e2e` | `~/projects/instant-native-webview-e2e` | 1 | 8 | 2026-08-30 test: add compiled Tauri WebView E2E | conflicts(6) | 1/0 | 11f, 4433+, 153- | test: add compiled Tauri WebView E2E |
| conflicts | `feature/sequence-board-e2e` | `~/projects/instant/.worktrees/sequence-board-e2e` | 3 | 2 | 2026-08-22 md: replace sequence actor projection | conflicts(6) | 3/0 | 9f, 799+, 13- | md: replace sequence actor projection (+2 more) |
| conflicts | `feature/focused-family-marbler-flash4` | `—` | 1 | 0 | 2026-08-18 feat: render family-scoped Marbler network in focu | conflicts(6) | 1/0 | 9f, 362+, 59- | feat: render family-scoped Marbler network in focused strip |
| conflicts | `feature/resize-family-strip-terra` | `—` | 1 | 0 | 2026-08-18 Resize focused Boop family strip | conflicts(3) | 1/0 | 5f, 135+, 7- | Resize focused Boop family strip |
| conflicts | `lane/instant-grid-file-tree` | `—` | 2 | 0 | 2026-08-10 Record file-tree migration commit | conflicts(6) | 2/0 | 11f, 264+, 138- | Record file-tree migration commit (+1 more) |
| conflicts | `lab/text-render-bench` | `—` | 1 | 0 | 2026-08-07 lab(preview): benchmark text renderers | conflicts(2) | 1/0 | 5f, 326+ | lab(preview): benchmark text renderers |
| conflicts | `feat/patchset-diff` | `—` | 2 | 0 | 2026-08-06 feat(preview): render linked diagrams and document | conflicts(21) | 1/1 | 53f, 1812+, 73- | feat(preview): render linked diagrams and documents (+1 more) |
| stale-wip | `feature/concat-map` | `—` | 5 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(1) | 5/0 | 5f, 217+ | wip: preserve uncommitted work before reclaiming the worktree (+4 more) |
| stale-wip | `ui/patchset-diff-polish` | `~/projects/instant/.worktrees/patchset-ui` | 10 | 1 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(4) | 10/0 | 25f, 1787+, 2- | wip: preserve uncommitted work before reclaiming the worktree (+5 more) |
| stale-wip | `feat/canvas-composition` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(2) | 1/0 | 10f, 317+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `lab/dockview-reactflow` | `~/projects/instant/.worktrees/dockview-reactflow-lab` | 1 | 1 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(1) | 1/0 | 10f, 446+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `lab/instant-rectangle-adapter` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(3) | 1/0 | 16f, 1115+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `lab/rxjs-style-extract` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | clean | 1/0 | 4f, 142+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `lane/flash-json-rx-gate` | `~/projects/instant/.worktrees/flash-json-rx-gate` | 1 | 1 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | clean | 1/0 | 1f, 23+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `chore/agent-network-plan-q38` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | clean | 1/0 | 1f, 241+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `chore/shell-v2-recon-q38c` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | clean | 1/0 | 1f, 804+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `feature/session-location-consumer` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(14) | 1/0 | 18f, 696+, 166- | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `feature/shell-v2-q38b` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | conflicts(1) | 1/0 | 4f, 338+ | wip: preserve uncommitted work before reclaiming the worktree |
| stale-wip | `feature/shell-v2-q38c` | `—` | 1 | 0 | 2026-08-30 wip: preserve uncommitted work before reclaiming t | clean | 1/0 | 3f, 329+ | wip: preserve uncommitted work before reclaiming the worktree |
| superseded | `refactor/tauri-request-signals` | `~/projects/worktrees/instant-tauri-request-signals` | 1 | 0 | 2026-08-30 transport: move native commands behind endpoints | conflicts(4) | 0/1 | 12f, 410+, 81- | transport: move native commands behind endpoints |
| superseded | `fix/focused-family-network-v3` | `—` | 4 | 0 | 2026-08-19 build: consume marbler 0.0.2 | conflicts(15) | 0/4 | 16f, 274+, 160- | build: consume marbler 0.0.2 (+3 more) |
| superseded | `feature/network-family-viz-luna` | `—` | 1 | 0 | 2026-08-18 add inline Boop family network visualization | conflicts(2) | 0/1 | 5f, 133+, 1- | add inline Boop family network visualization |
| superseded | `fix/instant-boop-family-consumer-luna` | `—` | 4 | 0 | 2026-08-18 consume Boop focused family graph in terminal stri | conflicts(10) | 0/4 | 12f, 409+, 99- | consume Boop focused family graph in terminal strip (+3 more) |
| superseded | `fix/claude-family-strip-flash4` | `—` | 3 | 0 | 2026-08-18 fix: show focused Boop family tree in terminal str | conflicts(9) | 0/3 | 10f, 111+, 82- | fix: show focused Boop family tree in terminal strip (+2 more) |
| superseded | `fix/boop-network-tab` | `—` | 3 | 0 | 2026-08-18 fix: show focused Boop family tree in terminal str | conflicts(9) | 0/3 | 10f, 111+, 82- | fix: show focused Boop family tree in terminal strip (+2 more) |
| superseded | `boop-agent-explorer-luna2` | `—` | 2 | 0 | 2026-08-17 fix: consume exported Marbler package surface | conflicts(4) | 0/2 | 8f, 744+ | fix: consume exported Marbler package surface (+1 more) |
| superseded | `fix/boop-external-shells-e2e-luna` | `—` | 1 | 0 | 2026-08-17 test: prove Boop external shell viewer lifecycle | conflicts(5) | 0/1 | 6f, 179+, 5- | test: prove Boop external shell viewer lifecycle |
| superseded | `fix/boop-external-shells-luna` | `—` | 5 | 0 | 2026-08-17 fix livespawn Boop executable boundary | conflicts(29) | 0/5 | 42f, 349+, 1495- | fix livespawn Boop executable boundary (+4 more) |
| superseded | `feat/monaco-preview` | `—` | 1 | 0 | 2026-08-07 feat(preview): open source files in Monaco | conflicts(3) | 0/1 | 10f, 325+, 58- | feat(preview): open source files in Monaco |
| superseded | `fix/claude-wheel-page-keys` | `—` | 1 | 0 | 2026-08-06 fix(terminal): leave Claude wheel input native | conflicts(3) | 0/1 | 3f, 2+, 36- | fix(terminal): leave Claude wheel input native |
| superseded | `fix/reopen-latest-closed` | `—` | 1 | 0 | 2026-08-05 fix(terminal): restore close and wheel ownership | conflicts(8) | 0/1 | 13f, 203+, 12- | fix(terminal): restore close and wheel ownership |
| dirty-only | `fix/md-focus-e2e` | `~/projects/instant-md-focus-e2e` | 0 | 1 | 2026-09-22 fix(md): install compact layout and protect inline | — | — |  | worktree edits only |
| dirty-only | `fix/cmdclick-ladder` | `~/projects/instant-worktrees/cmdclick` | 0 | 6 | 2026-09-22 fix(md): install compact layout and protect inline | — | — |  | worktree edits only |
| dirty-only | `fix/md-reading` | `~/projects/instant-md-reading` | 0 | 6 | 2026-09-20 docs: record reviewed sequential CI fixes and sess | — | — |  | worktree edits only |
| dirty-only | `fix/turn-remind-20260921` | `~/projects/instant-turn-remind` | 0 | 3 | 2026-09-20 docs: record reviewed sequential CI fixes and sess | — | — |  | worktree edits only |
| dirty-only | `fix/tmux-closing-regression` | `~/projects/instant-worktrees/tmux-closing` | 0 | 3 | 2026-09-18 fix(pty): reap a dead tmux pane when its tab close | — | — |  | worktree edits only |
| dirty-only | `fix/instant-interaction-bugs` | `~/projects/instant-worktrees/fixes-integration` | 0 | 28 | 2026-09-18 chore: consume local md renderer build | — | — |  | worktree edits only |
| dirty-only | `fix/preview-performance` | `~/projects/instant-worktrees/preview-performance` | 0 | 16 | 2026-09-18 chore: consume local md renderer build | — | — |  | worktree edits only |
| dirty-only | `fix/selection-ask` | `~/projects/instant-worktrees/selection-ask` | 0 | 7 | 2026-09-18 chore: consume local md renderer build | — | — |  | worktree edits only |
| dirty-only | `feat/agent-squares` | `~/projects/instant/.boop-worktrees/feat/agent-squares` | 0 | 2 | 2026-09-17 feat(squares): a finger-sized target, diagrams in  | — | — |  | worktree edits only |
| dirty-only | `feat/xterm-webgl` | `~/projects/instant/.boop-worktrees/feat/xterm-webgl` | 0 | 2 | 2026-09-17 pty: flow control between xterm.js and the pty rea | — | — |  | worktree edits only |
| dirty-only | `feature/timeline-mermaid-opencode` | `~/projects/instant/.boop-worktrees/feature/timeline-mermaid-opencode` | 0 | 2 | 2026-09-14 terminal diagrams: detect mermaid timelines in ope | — | — |  | worktree edits only |
| dirty-only | `integration/tauri-condom` | `~/projects/instant-worktrees/condom` | 0 | 4 | 2026-09-08 click rules: a launcher rule opens no results tab; | — | — |  | worktree edits only |
| dirty-only | `chore/drop-next-button` | `~/projects/instant-worktrees/tmux-rename` | 0 | 1 | 2026-08-30 queue: drop the "+ next" button, leave the right-c | — | — |  | worktree edits only |
| primary-owned | `refactor/lift-wave-3` | `~/projects/instant/.boop-worktrees/refactor/lift-wave-3` | 6 | 2 | 2026-09-26 | — | — | — | the xterm cutover; skipped here |

### instant main checkout: uncommitted files by directory

| dir | files | newest mtime | < 2h (likely another agent in progress) |
| --- | --- | --- | --- |
| `issues/lift-wave-3` | 1 | 2026-09-26 10:56 |  |
| `issues/adopted-harness-resumes` | 1 | 2026-09-26 10:13 |  |
| `issues/lift-wave-2` | 1 | 2026-09-26 00:22 |  |
| `issues/lift-wave-1c` | 1 | 2026-09-25 22:34 |  |
| `issues/markdown-fence-commands` | 1 | 2026-09-25 12:52 |  |
| `plans/briefs` | 3 | 2026-09-25 12:51 |  |
| `artifacts/real` | 18 | 2026-09-24 20:03 |  |
| `issues/kernel-wired-growth` | 1 | 2026-09-23 17:45 |  |
| `artifacts/wired-leak` | 12 | 2026-09-23 14:50 |  |
| `issues/hashed-route-falls-to-find-all` | 1 | 2026-09-22 09:21 |  |
| `rtifacts/real` | 1 | deleted |  |

## hafley-rxjs

| bucket | branch | worktree | ahead | dirty | last commit | merge | cherry +/- | diff | what |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| merge-ready-old | `chore/signal-grid-live-demos` | `~/projects/hafley-rxjs/.boop-worktrees/chore/signal-grid-live-demos` | 1 | 0 | 2026-09-10 signal-grid: buy vs build for inline live demos | clean | 1/0 | 1f, 155+ | signal-grid: buy vs build for inline live demos |
| merge-ready-old | `chore/vitest-playwright-plan-review2` | `~/projects/hafley-rxjs/.boop-worktrees/chore/vitest-playwright-plan-review2` | 1 | 0 | 2026-09-08 review: vitest-playwright plan v2 adversarial pass | clean | 1/0 | 1f, 133+ | review: vitest-playwright plan v2 adversarial pass |
| merge-ready-old | `chore/vitest-playwright-plan-review` | `~/projects/hafley-rxjs/.boop-worktrees/chore/vitest-playwright-plan-review` | 1 | 0 | 2026-09-08 review: vitest-playwright plan adversarial pass | clean | 1/0 | 1f, 86+ | review: vitest-playwright plan adversarial pass |
| conflicts | `feature/boop-xterm-wave2` | `—` | 3 | 0 | 2026-09-26 wip: zombie-lane drafts (superseded by wave2b), sa | conflicts(4) | 3/0 | 9f, 667+, 1- | wip: zombie-lane drafts (superseded by wave2b), saved before reap (+2 more) |
| conflicts | `backup/boop-xterm-wave2` | `—` | 2 | 0 | 2026-09-25 feat(boop-xterm): wheel stream | conflicts(1) | 2/0 | 4f, 268+ | feat(boop-xterm): wheel stream (+1 more) |
| conflicts | `wip/md-table-fit` | `—` | 4 | 0 | 2026-09-25 WIP(md, signal-grid): content-fit table columns, i | conflicts(2) | 1/3 | 12f, 426+, 4- | WIP(md, signal-grid): content-fit table columns, inline code never bre (+3 more) |
| conflicts | `fix/md-reading` | `~/projects/hafley-rxjs-md-reading` | 1 | 3 | 2026-09-21 feat(md): render markdown tables with signal-grid | conflicts(17) | 1/0 | 45f, 3413+, 50- | feat(md): render markdown tables with signal-grid |
| conflicts | `refactor/grid-drop-change` | `~/projects/hafley-rxjs/.boop-worktrees/refactor/grid-drop-change` | 1 | 0 | 2026-09-11 signal-grid: the change phase had 38 senders and n | conflicts(5) | 1/0 | 24f, 480+, 414- | signal-grid: the change phase had 38 senders and nobody listening |
| conflicts | `feature/docs-kit` | `~/projects/hafley-rxjs/.boop-worktrees/feature/docs-kit` | 4 | 0 | 2026-09-10 signals: a react page where the plugin is the thin | conflicts(41) | 3/1 | 135f, 12099+, 3162- | signals: a react page where the plugin is the thing being shown (+3 more) |
| conflicts | `feature/signal-grid-interaction` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-interaction` | 1 | 0 | 2026-09-10 signal-grid: the five interactions ship on, and a  | conflicts(7) | 1/0 | 14f, 417+, 150- | signal-grid: the five interactions ship on, and a caller drops one by  |
| conflicts | `feature/signal-grid-run-when-in-view` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-run-when-in-view` | 4 | 0 | 2026-09-10 signal-grid: the documents show the stream carryin | conflicts(32) | 4/0 | 39f, 518+, 285- | signal-grid: the documents show the stream carrying its own effect (+3 more) |
| conflicts | `fix/signal-grid-controlled-state` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-controlled-state` | 1 | 0 | 2026-09-10 signal-grid: a state signal the caller holds is co | conflicts(4) | 1/0 | 13f, 258+, 33- | signal-grid: a state signal the caller holds is controlled in both dir |
| conflicts | `feature/signal-grid-field-paths` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-field-paths` | 1 | 0 | 2026-09-10 signal-grid: a state signal handed in is the grid' | conflicts(7) | 1/0 | 7f, 132+, 23- | signal-grid: a state signal handed in is the grid's state |
| conflicts | `feature/signal-grid-finish` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-finish` | 3 | 0 | 2026-09-10 signal-grid: the shipped stats file carries this t | conflicts(15) | 3/0 | 20f, 679+, 246- | signal-grid: the shipped stats file carries this tree's measurements (+2 more) |
| conflicts | `feature/signal-grid-col-virtualization` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-col-virtualization` | 1 | 0 | 2026-09-10 signal-grid: one windowing over whichever facet is | conflicts(9) | 1/0 | 10f, 263+, 53- | signal-grid: one windowing over whichever facet is asked, so a transpo |
| conflicts | `feature/signal-grid-inline-demos` | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-inline-demos` | 1 | 0 | 2026-09-10 signal-grid: the timings strip reads the real log  | conflicts(3) | 1/0 | 3f, 31+, 55- | signal-grid: the timings strip reads the real log surface, and two pan |
| conflicts | `fix/signal-grid-transpose-real` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-transpose-real` | 1 | 0 | 2026-09-10 signal-grid: the detail demo stops advertising its | conflicts(1) | 1/0 | 1f, 3+, 6- | signal-grid: the detail demo stops advertising its two falsified defec |
| conflicts | `fix/signal-grid-bench-truth` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-bench-truth` | 5 | 0 | 2026-09-10 signal-grid: regenerate stats.json with the epics  | conflicts(4) | 3/2 | 6f, 395+, 509- | signal-grid: regenerate stats.json with the epics and features keys (+4 more) |
| conflicts | `fix/signal-grid-demo-cards` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-demo-cards` | 1 | 0 | 2026-09-10 signal-grid: the demo readme cites the lines it cl | conflicts(1) | 1/0 | 1f, 12+, 18- | signal-grid: the demo readme cites the lines it claims |
| conflicts | `feature/signal-scan-expand` | `—` | 4 | 0 | 2026-09-08 signals: writable memos by default, { writable: fa | conflicts(5) | 4/0 | 7f, 521+, 55- | signals: writable memos by default, { writable: false } opts out (+3 more) |
| conflicts | `feature/embedded-chrome` | `~/projects/hafley-rxjs/.worktrees/embedded-chrome` | 2 | 1 | 2026-09-01 marbler: measure the waterfall column offset inste | conflicts(3) | 1/1 | 3f, 117+, 49- | marbler: measure the waterfall column offset instead of the demo const (+1 more) |
| conflicts | `feature/generic-graph-rxjs-renderers` | `~/projects/hafley-rxjs/.boop-worktrees/feature/generic-graph-rxjs-renderers` | 40 | 0 | 2026-08-25 grapht: repair categorized file references | conflicts(31) | 40/0 | 185f, 9970+, 1722- | grapht: repair categorized file references (+5 more) |
| conflicts | `refactor/grapht-source-layout` | `~/projects/hafley-rxjs/.boop-worktrees/refactor/grapht-source-layout` | 40 | 0 | 2026-08-25 grapht: repair categorized file references | conflicts(31) | 40/0 | 185f, 9970+, 1722- | grapht: repair categorized file references (+5 more) |
| conflicts | `feature/grapht-contract-gate` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-contract-gate` | 31 | 0 | 2026-08-25 grapht: define visual port contract | conflicts(33) | 31/0 | 128f, 9668+, 1592- | grapht: define visual port contract (+5 more) |
| conflicts | `feature/grapht-model-sequence-core` | `~/projects/hafley-rxjs/.worktrees/grapht-model-sequence-core` | 1 | 0 | 2026-08-22 grapht-model: add graph and sequence board contrac | conflicts(7) | 1/0 | 14f, 782+ | grapht-model: add graph and sequence board contracts |
| conflicts | `feature/grid-document-virtualization-terra` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grid-document-virtualization-terra` | 7 | 0 | 2026-08-17 fix(grid): collapse terminal virtual viewport | conflicts(16) | 1/6 | 23f, 1400+, 73- | fix(grid): collapse terminal virtual viewport (+5 more) |
| conflicts | `feature/grapht-pixijs-v3` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-pixijs-v3` | 17 | 0 | 2026-08-11 grapht: add PixiJS v8 renderer adapter lane | conflicts(47) | 17/0 | 229f, 14198+, 30- | grapht: add PixiJS v8 renderer adapter lane (+5 more) |
| conflicts | `feature/grapht-vello-chromium` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-vello-chromium` | 17 | 1 | 2026-08-11 Add Vello Chromium WebGPU lane | conflicts(36) | 17/0 | 216f, 12239+, 30- | Add Vello Chromium WebGPU lane (+5 more) |
| conflicts | `feature/grapht-flash-scenarios` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-flash-scenarios` | 17 | 0 | 2026-08-11 grapht: record scenario handler commit hash in REP | conflicts(42) | 17/0 | 207f, 11482+, 33- | grapht: record scenario handler commit hash in REPORT (+5 more) |
| conflicts | `feature/grapht-luna-scenarios` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-luna-scenarios` | 16 | 1 | 2026-08-11 grapht: add cytoscape and sigma scenario lane | conflicts(33) | 16/0 | 202f, 10693+, 30- | grapht: add cytoscape and sigma scenario lane (+5 more) |
| conflicts | `feature/grapht-pixijs` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-pixijs` | 16 | 0 | 2026-08-11 grapht: add cytoscape and sigma scenario lane | conflicts(33) | 16/0 | 202f, 10693+, 30- | grapht: add cytoscape and sigma scenario lane (+5 more) |
| conflicts | `feature/grapht-pixijs-v2` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-pixijs-v2` | 16 | 0 | 2026-08-11 grapht: add cytoscape and sigma scenario lane | conflicts(33) | 16/0 | 202f, 10693+, 30- | grapht: add cytoscape and sigma scenario lane (+5 more) |
| conflicts | `feature/grapht-integration` | `~/projects/hafley-rxjs/.worktrees/grapht-integration` | 15 | 0 | 2026-08-11 grapht: normalize renderer fixtures and scenario c | conflicts(36) | 15/0 | 192f, 9824+, 33- | grapht: normalize renderer fixtures and scenario contract (+5 more) |
| conflicts | `feature/grapht-renderer-breakpoints` | `~/projects/hafley-rxjs/.worktrees/grapht-breakpoints` | 14 | 0 | 2026-08-11 grapht: record renderer breakpoint receipts | conflicts(42) | 14/0 | 173f, 9086+, 33- | grapht: record renderer breakpoint receipts (+5 more) |
| conflicts | `feature/grapht-render-sigma` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-render-sigma` | 1 | 0 | 2026-08-10 feat(grapht): add sigma projection adapter | conflicts(9) | 1/0 | 35f, 2134+ | feat(grapht): add sigma projection adapter |
| conflicts | `feature/grapht-render-vello-wgpu` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-render-vello-wgpu` | 1 | 0 | 2026-08-10 feat(grapht): add vello wgpu projection probe | conflicts(5) | 1/0 | 24f, 2067+ | feat(grapht): add vello wgpu projection probe |
| conflicts | `feature/grapht-render-canvaskit` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-render-canvaskit` | 2 | 0 | 2026-08-10 feat(grapht): add CanvasKit receipt artifacts | conflicts(6) | 2/0 | 19f, 674+ | feat(grapht): add CanvasKit receipt artifacts (+1 more) |
| conflicts | `feature/grapht-render-cytoscape` | `—` | 1 | 0 | 2026-08-10 feat(grapht): add Cytoscape projection adapter | conflicts(7) | 1/0 | 15f, 298+ | feat(grapht): add Cytoscape projection adapter |
| conflicts | `feature/grapht-layout-rust-wasm` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-layout-rust-wasm` | 2 | 0 | 2026-08-10 chore(grapht): ignore local Wasm build output | conflicts(3) | 2/0 | 20f, 358+ | chore(grapht): ignore local Wasm build output (+1 more) |
| conflicts | `feature/grapht-layout-worker-js` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-layout-worker-js` | 1 | 0 | 2026-08-10 feat(grapht): add worker grid layout adapter | conflicts(1) | 1/0 | 16f, 494+ | feat(grapht): add worker grid layout adapter |
| conflicts | `feature/grapht-bench-protocol-v2` | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-bench-protocol-v2` | 1 | 0 | 2026-08-10 feat(grapht): add implementation-agnostic benchmar | conflicts(10) | 1/0 | 31f, 1673+ | feat(grapht): add implementation-agnostic benchmark protocol |
| superseded | `chore/boop-props-map` | `—` | 1 | 0 | 2026-09-25 plans: boop props map report | clean | 0/1 | 1f, 179+ | plans: boop props map report |
| superseded | `chore/boop-xterm-lift-map` | `—` | 1 | 0 | 2026-09-25 docs(tasks): boop-xterm lift map report | clean | 0/1 | 1f, 422+ | docs(tasks): boop-xterm lift map report |
| superseded | `chore/md-main-inventory` | `—` | 1 | 0 | 2026-09-25 docs(tasks): md main inventory report | clean | 0/1 | 1f, 122+ | docs(tasks): md main inventory report |
| superseded | `fix/grapht-cyto-dark` | `~/projects/hafley-rxjs/.boop-worktrees/fix/grapht-cyto-dark` | 1 | 0 | 2026-09-13 Add dark theme to native Cytoscape sequence render | conflicts(4) | 0/1 | 5f, 259+, 34- | Add dark theme to native Cytoscape sequence renderer and sticky overla |
| superseded | `fix/marbler-embedded-grid` | `—` | 3 | 0 | 2026-08-19 feat(marbler): focus toolbar on agent events | conflicts(7) | 0/3 | 9f, 33+, 20- | feat(marbler): focus toolbar on agent events (+2 more) |
| superseded | `feature/marbler-exports-luna` | `—` | 1 | 0 | 2026-08-17 Export Marbler model and panel | conflicts(7) | 0/1 | 7f, 20+, 16- | Export Marbler model and panel |
| superseded | `feature/boop-agent-adapters-luna` | `—` | 2 | 0 | 2026-08-17 Fix native package type exports | conflicts(11) | 0/2 | 21f, 614+, 15- | Fix native package type exports (+1 more) |
| dirty-only | `codex/integrate-md-tables` | `~/projects/hafley-rxjs-main-push` | 0 | 1 | 2026-09-21 fix(md): declare mdast types directly | — | — |  | worktree edits only |
| dirty-only | `feature/demo-react-source` | `~/projects/hafley-rxjs/.boop-worktrees/feature/demo-react-source` | 0 | 1 | 2026-09-11 signal-grid: the React button shows React, and the | — | — |  | worktree edits only |
| dirty-only | `feature/demo-react-tab` | `~/projects/hafley-rxjs/.boop-worktrees/feature/demo-react-tab` | 0 | 1 | 2026-09-10 signal-grid: one example, two renderers, and one s | — | — |  | worktree edits only |
| dirty-only | `fix/signals-emit-turn` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signals-emit-turn` | 0 | 4 | 2026-09-10 signals: a torn-down consumer releases its source | — | — |  | worktree edits only |
| dirty-only | `fix/signal-grid-wire-embeds` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-wire-embeds` | 0 | 6 | 2026-09-10 signal-grid: five mechanical type and gesture fixe | — | — |  | worktree edits only |
| dirty-only | `fix/signal-grid-type-fixes` | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-type-fixes` | 0 | 1 | 2026-09-10 signal-grid: a built-in column def stops re-declar | — | — |  | worktree edits only |
| dirty-only | `chore/review-grid-epics` | `~/projects/hafley-rxjs/.boop-worktrees/chore/review-grid-epics` | 0 | 162 | 2026-09-02 marbler: measure the waterfall column offset inste | — | — |  | worktree edits only |
| dirty-only | `lane/jsonrx-dom` | `~/projects/hafley-rxjs/.worktrees/jsonrx-dom` | 0 | 8 | 2026-07-22 docs(json-rx): record reactive state axes | — | — |  | worktree edits only |

### hafley-rxjs main checkout: uncommitted files by directory

| dir | files | newest mtime | < 2h (likely another agent in progress) |
| --- | --- | --- | --- |
| `packages/md/src` | 6 | 2026-09-26 12:28 | yes |
| `plans/2026-09-26-md-echarts` | 1 | 2026-09-26 12:24 | yes |
| `packages/marbler/src` | 1 | 2026-09-25 09:13 |  |
| `chat_log/20260925.0.instant-boop-md-triage-and-fixes.md` | 1 | 2026-09-25 01:14 |  |
| `packages/signals/docs` | 1 | 2026-09-23 18:28 |  |
| `packages/path/scripts` | 5 | 2026-09-18 18:19 |  |
| `packages/path/src` | 4 | 2026-09-18 18:18 |  |
| `packages/path/README.md` | 1 | 2026-09-18 16:15 |  |
| `packages/path/test` | 4 | 2026-09-18 16:15 |  |
| `packages/path/package.json` | 1 | 2026-09-18 16:14 |  |
| `out/cmd-row.txt` | 1 | 2026-09-18 15:48 |  |
| `out/lane-mail.txt` | 1 | 2026-09-18 15:48 |  |
| `out/critique-row.json` | 1 | 2026-09-18 15:43 |  |
| `packages/bewpp/src` | 25 | 2026-09-18 15:35 |  |
| `packages/boop-adapters/src` | 1 | 2026-09-18 13:47 |  |
| `packages/rxjsx/tsconfig.tsbuildinfo` | 1 | 2026-09-18 13:46 |  |
| `packages/path-router-lab/tsconfig.json` | 1 | 2026-09-18 13:03 |  |
| `packages/report-shell/src` | 1 | 2026-09-18 13:03 |  |
| `chat_log/20260918.1.bewpp-cli-hateoas-context-diet.md` | 1 | 2026-09-18 12:24 |  |
| `chat_log/20260918.0.bewpp-cli-hateoas-context-diet.md` | 1 | 2026-09-18 12:04 |  |
| `packages/bewpp/package.json` | 1 | 2026-09-18 11:16 |  |
| `packages/bewpp/0_build.mjs` | 1 | 2026-09-18 11:16 |  |
| `packages/path/tsconfig.build.json` | 1 | 2026-09-18 11:01 |  |
| `issues/bewpp-locator-did-you-mean` | 1 | 2026-09-18 10:57 |  |
| `packages/path/.gitignore` | 1 | 2026-09-18 10:40 |  |
| `packages/bewpp/tests` | 2 | 2026-09-17 21:02 |  |
| `packages/bewpp/README.md` | 1 | 2026-09-17 20:57 |  |
| `plans/2026-09-16-pokemon-agents.md` | 1 | 2026-09-16 12:25 |  |
| `packages/signal-grid/docs` | 1 | 2026-09-15 21:03 |  |
| `.boop-briefs/pwp-semaphore.md` | 1 | 2026-09-15 19:56 |  |
| `.boop-briefs/pwp-red-tests.md` | 1 | 2026-09-15 19:56 |  |
| `.boop-briefs/grid-aria.md` | 1 | 2026-09-13 17:24 |  |
| `packages/signals/site` | 1 | 2026-09-13 17:23 |  |
| `packages/signal-grid/site` | 1 | 2026-09-13 17:23 |  |
| `.boop-briefs/xdom-chords.md` | 1 | 2026-09-13 17:03 |  |
| `.boop-briefs/grid-color-scheme.md` | 1 | 2026-09-13 17:02 |  |
| `.boop-briefs/trace-life.md` | 1 | 2026-09-13 14:53 |  |
| `packages/grapht/tour` | 3 | 2026-09-13 14:42 |  |
| `.boop-briefs/grapht-docs.md` | 1 | 2026-09-13 14:23 |  |
| `.boop-briefs/grapht-seq-fixture.md` | 1 | 2026-09-13 13:18 |  |
| `.boop-briefs/grapht-pages-site.md` | 1 | 2026-09-12 11:36 |  |
| `.boop-briefs/fix-kill-jsdom-golden.md` | 1 | 2026-09-12 10:19 |  |
| `packages/gothic/src` | 1 | 2026-09-12 01:34 |  |
| `packages/gothic/tools` | 3 | 2026-09-11 22:58 |  |
| `packages/grapht/adapters` | 2 | 2026-08-11 13:17 |  |
| `hat_log/LATEST.md` | 1 | deleted |  |

## hafley-rs

| bucket | branch | worktree | ahead | dirty | last commit | merge | cherry +/- | diff | what |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| merge-ready | `fix/the-gang-lists-its-kinds` | `~/projects/hafley-rs/.boop-worktrees/fix/the-gang-lists-its-kinds` | 2 | 0 | 2026-09-26 scm: cover has kind lists and report scope | clean | 2/0 | 5f, 95+, 38- | scm: cover has kind lists and report scope (+1 more) |
| merge-ready | `feature/ryi-rust-round3` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-rust-round3` | 7 | 0 | 2026-09-26 Constrain Rust resolution by Cargo targets and qua | clean | 7/0 | 36f, 799+, 66- | Constrain Rust resolution by Cargo targets and qualified modules (+5 more) |
| merge-ready | `feature/ryi-serve-result` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-serve-result` | 5 | 0 | 2026-09-26 Stream finite ryi JSONL responses and preserve lat | clean | 5/0 | 23f, 737+, 263- | Stream finite ryi JSONL responses and preserve late errors (+4 more) |
| merge-ready | `feature/ryi-ts-round3` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-ts-round3` | 7 | 0 | 2026-09-26 Fix TS shared-blob targets and local peer calls | clean | 7/0 | 17f, 470+, 55- | Fix TS shared-blob targets and local peer calls (+5 more) |
| merge-ready | `feature/ryi-edit-soopy-bugs` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-edit-soopy-bugs` | 8 | 0 | 2026-09-26 ryi rename: plan indexed batches over sequential o | clean | 8/0 | 23f, 240+, 27- | ryi rename: plan indexed batches over sequential overlays (+5 more) |
| merge-ready | `review/sol6-src` | `~/projects/hafley-rs/.boop-worktrees/review/sol6-src` | 1 | 0 | 2026-09-26 plans: review sol6 source lanes | clean | 1/0 | 1f, 22+ | plans: review sol6 source lanes |
| merge-ready | `feature/ryi-sqlite-bind` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-sqlite-bind` | 8 | 0 | 2026-09-26 test(ryi): cover SQLite text interner hash collisi | clean | 8/0 | 5f, 396+, 101- | test(ryi): cover SQLite text interner hash collisions (+5 more) |
| merge-ready | `feature/ryi-sqlite-writer` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-sqlite-writer` | 3 | 0 | 2026-09-26 perf(ryi): profile SQLite bind work by column kind | clean | 3/0 | 4f, 263+, 48- | perf(ryi): profile SQLite bind work by column kind (+2 more) |
| merge-ready | `fix/omp-live-trait-e2e-terra` | `—` | 1 | 0 | 2026-09-15 test(boop): cover live pane route fallback | clean | 1/0 | 1f, 33+ | test(boop): cover live pane route fallback |
| merge-ready | `feature/context-cap` | `—` | 1 | 0 | 2026-09-12 context-cap: report why fable-5-1 shows 200k and t | clean | 1/0 | 1f, 48+ | context-cap: report why fable-5-1 shows 200k and the [1m] fix |
| merge-ready-old | `feature/f41-game-combat-direct-port` | `—` | 1 | 0 | 2026-09-11 feat(games): extract pure game-combat hit resolver | clean | 1/0 | 6f, 547+ | feat(games): extract pure game-combat hit resolver |
| merge-ready-old | `feature/f41-game-combat-direct-port2` | `—` | 1 | 0 | 2026-09-11 feat(games): port v1 combat resolution into game-c | clean | 1/0 | 6f, 676+ | feat(games): port v1 combat resolution into game-combat |
| merge-ready-old | `feature/f41-game-combat-direct-port3` | `—` | 1 | 0 | 2026-09-11 feat(games): extract pure game-combat hit resolver | clean | 1/0 | 6f, 599+ | feat(games): extract pure game-combat hit resolver |
| merge-ready-old | `chore/falcon-movement-evidence` | `—` | 2 | 0 | 2026-09-10 fighter: game-fighter locomotion crate (Rules/Stat | clean | 2/0 | 9f, 1158+ | fighter: game-fighter locomotion crate (Rules/State/advance + redux Sl (+1 more) |
| conflicts | `feat/observe-sqlite` | `—` | 25 | 0 | 2026-09-24 wip: rustfmt observe and bulk-trigger, sprefa lock | conflicts(25) | 16/9 | 133f, 13769+, 360- | wip: rustfmt observe and bulk-trigger, sprefa lock, briefs and issue n (+5 more) |
| conflicts | `fix/turn-remind-20260921` | `~/projects/hafley-rs-turn-remind` | 10 | 0 | 2026-09-21 Track user turns for attribution and remind | conflicts(7) | 2/8 | 61f, 4351+, 51- | Track user turns for attribution and remind (+5 more) |
| conflicts | `feature/watch-the-watchman` | `~/projects/hafley-rs/.boop-worktrees/feature/watch-the-watchman` | 12 | 0 | 2026-09-21 observe: one tracy client for both features, and i | conflicts(5) | 12/0 | 28f, 4041+, 61- | observe: one tracy client for both features, and install the allocator (+5 more) |
| conflicts | `fix/codex-revive-attribution` | `~/projects/hafley-rs-wt/codex-revive-attribution` | 3 | 2 | 2026-09-20 observe: cut 0.1.2 so the chrome, count and sqlite | conflicts(7) | 1/2 | 10f, 471+, 8- | observe: cut 0.1.2 so the chrome, count and sqlite rails reach consume (+2 more) |
| conflicts | `chore/observe-buy-trial` | `~/projects/hafley-rs/.boop-worktrees/chore/observe-buy-trial` | 7 | 0 | 2026-09-19 observe: drop bigoish, the trial rejected it | conflicts(3) | 6/1 | 4f, 175+, 1- | observe: drop bigoish, the trial rejected it (+5 more) |
| conflicts | `wip/hafley-main-checkout-20260918` | `—` | 2 | 0 | 2026-09-18 wip: park untracked turnvis drafts with the rest | conflicts(8) | 2/0 | 16f, 1042+, 93- | wip: park untracked turnvis drafts with the rest (+1 more) |
| conflicts | `feature/extract-lane-c-ktpy` | `—` | 1 | 0 | 2026-09-17 wip(extract): lane c-ktpy state at opencode death | conflicts(2) | 1/0 | 4f, 302+, 10- | wip(extract): lane c-ktpy state at opencode death |
| conflicts | `feature/redux-independent-copy` | `—` | 1 | 0 | 2026-09-15 feat(redux): add independent workspace package | conflicts(2) | 1/0 | 39f, 7470+, 11- | feat(redux): add independent workspace package |
| conflicts | `feature/omp-harness-a2` | `—` | 2 | 0 | 2026-09-14 fix(boop): omp lanes spawn through the supervisor | conflicts(4) | 2/0 | 13f, 410+, 6- | fix(boop): omp lanes spawn through the supervisor (+1 more) |
| conflicts | `feature/terra-observe-otel-20260914` | `—` | 5 | 0 | 2026-09-14 docs(hafley-observe): explain root lockfile prunin | conflicts(5) | 5/0 | 6f, 1061+, 2828- | docs(hafley-observe): explain root lockfile pruning (+4 more) |
| conflicts | `feature/omp-harness-a` | `—` | 1 | 0 | 2026-09-14 wip(boop): omp harness skeleton, uncorrected | conflicts(6) | 1/0 | 13f, 356+, 6- | wip(boop): omp harness skeleton, uncorrected |
| conflicts | `feature/f41-ghcache-final-20260912` | `—` | 18 | 0 | 2026-09-12 boop: add cached review-notification adapter (sour | conflicts(2) | 18/0 | 20f, 3087+, 172- | boop: add cached review-notification adapter (source only) (+5 more) |
| conflicts | `extract/hafley-games` | `—` | 149 | 0 | 2026-09-11 refactor(games): unify fighter ground and air char | conflicts(0) | 149/0 |  | refactor(games): unify fighter ground and air chart (+5 more) |
| conflicts | `refactor/f41-action-state-owner` | `—` | 1 | 0 | 2026-09-11 refactor(games): move ActionState into canonical f | conflicts(4) | 1/0 | 4f, 36+, 39- | refactor(games): move ActionState into canonical fighter State |
| conflicts | `refactor/f41-lift-fighter-controller-cut2` | `—` | 1 | 0 | 2026-09-11 refactor(games): lift locomotion controller into g | conflicts(3) | 1/0 | 5f, 175+, 72- | refactor(games): lift locomotion controller into game-fighter |
| conflicts | `docs/gem38f-combat-field-diagrams` | `—` | 1 | 0 | 2026-09-11 docs(combat): annotate Strike, Target, DefenseInpu | conflicts(1) | 1/0 | 1f, 31+ | docs(combat): annotate Strike, Target, DefenseInput, and Launch fields |
| conflicts | `feature/f41-character-select-contract` | `—` | 1 | 0 | 2026-09-11 feat(games): author Smash character-select TypeSpe | conflicts(1) | 1/0 | 3f, 123+ | feat(games): author Smash character-select TypeSpec contract |
| conflicts | `feature/f41-dog-runtime-slice2` | `—` | 1 | 0 | 2026-09-11 feat(games): run Dog through the shared source-fre | conflicts(6) | 1/0 | 9f, 440+, 48- | feat(games): run Dog through the shared source-free controller |
| conflicts | `feature/f41-dog-status-cut4` | `—` | 1 | 0 | 2026-09-11 feat(games): report Dog action status beside Pigeo | conflicts(2) | 1/0 | 3f, 877+, 5- | feat(games): report Dog action status beside Pigeon |
| conflicts | `feature/f41-dog-status-cut3` | `—` | 1 | 0 | 2026-09-11 feat(games): report Dog alongside Pigeon in just s | conflicts(5) | 1/0 | 6f, 1299+, 77- | feat(games): report Dog alongside Pigeon in just status |
| conflicts | `refactor/f41-dog-movement-module` | `—` | 2 | 0 | 2026-09-11 refactor(games): root Dog at movement module | conflicts(3) | 2/0 | 6f, 442+, 41- | refactor(games): root Dog at movement module (+1 more) |
| conflicts | `feature/f41-pigeon-dog-attributes` | `—` | 1 | 0 | 2026-09-11 feat(games): generate checked Pigeon and Dog attri | conflicts(4) | 1/0 | 6f, 398+, 20- | feat(games): generate checked Pigeon and Dog attribute outputs |
| conflicts | `refactor/f41-character-generator-models` | `—` | 2 | 0 | 2026-09-10 refactor(games): name the character catalog genera | conflicts(1) | 2/0 | 3f, 247+ | refactor(games): name the character catalog generator models (+1 more) |
| conflicts | `refactor/f41-character-generator-core` | `—` | 2 | 0 | 2026-09-10 refactor(games): name character catalog input mode | conflicts(1) | 2/0 | 3f, 264+ | refactor(games): name character catalog input models (+1 more) |
| conflicts | `feature/glm53f-ftcommon-inventory` | `—` | 1 | 0 | 2026-09-10 feat(games): bounded ftCommon callback inventory f | conflicts(4) | 1/0 | 7f, 751+, 48- | feat(games): bounded ftCommon callback inventory from pinned C trees |
| conflicts | `chore/glm53f-falcon-source-status` | `—` | 1 | 0 | 2026-09-10 docs(games): record pinned-source rules status for | conflicts(6) | 1/0 | 6f, 146+, 90- | docs(games): record pinned-source rules status for 61b2195 |
| conflicts | `feature/f41-falcon-crouch-lifecycle` | `—` | 2 | 0 | 2026-09-10 test(games): tighten crouch cut per review | conflicts(16) | 2/0 | 16f, 343+, 177- | test(games): tighten crouch cut per review (+1 more) |
| conflicts | `fix/f41-game-status-harmonic` | `—` | 2 | 0 | 2026-09-10 fix(games): derive status selections and chart mem | conflicts(9) | 2/0 | 12f, 722+, 69- | fix(games): derive status selections and chart membership from live se (+1 more) |
| conflicts | `feature/f41-game-status-cut` | `—` | 1 | 0 | 2026-09-10 feat(games): expose executable Falcon catalog and  | conflicts(6) | 1/0 | 9f, 384+, 7- | feat(games): expose executable Falcon catalog and phase mapping in jus |
| conflicts | `feature/f41-air-chart-lift` | `—` | 2 | 0 | 2026-09-10 docs(games): record ordered game queue and parity  | conflicts(5) | 1/1 | 7f, 329+, 19- | docs(games): record ordered game queue and parity gate (+1 more) |
| conflicts | `chore/f41-statechart-remaining-review` | `—` | 2 | 0 | 2026-09-10 docs(games): reconcile remaining-machine counts an | conflicts(3) | 2/0 | 5f, 304+, 11- | docs(games): reconcile remaining-machine counts and state identity (+1 more) |
| conflicts | `chore/f41-statechart-remaining` | `—` | 1 | 0 | 2026-09-10 docs(games): audit remaining base movement transit | conflicts(3) | 1/0 | 4f, 145+, 11- | docs(games): audit remaining base movement transitions |
| conflicts | `fix/f41-browser-dash-dance` | `—` | 2 | 0 | 2026-09-10 fix(falcon-lab): suspend digital resolver across f | conflicts(5) | 1/1 | 6f, 153+, 7- | fix(falcon-lab): suspend digital resolver across focus loss (+1 more) |
| conflicts | `feature/opus-port-progress` | `—` | 2 | 0 | 2026-09-10 fix(games): apply coordinator corrections to the p | conflicts(6) | 2/0 | 10f, 844+, 9- | fix(games): apply coordinator corrections to the progress dashboard (+1 more) |
| conflicts | `feature/opus-falcon-observer` | `—` | 2 | 0 | 2026-09-10 test(games): jump out of TURN instead of re-dashin | conflicts(2) | 2/0 | 3f, 120+ | test(games): jump out of TURN instead of re-dashing in the observer ta (+1 more) |
| conflicts | `feature/static-ground-chart` | `—` | 1 | 0 | 2026-09-10 feat(games): generate exhaustive grounded statecha | conflicts(4) | 1/0 | 8f, 352+ | feat(games): generate exhaustive grounded statechart |
| conflicts | `feature/falcon-runtime-chart` | `—` | 2 | 0 | 2026-09-10 fix(games): reset phase observer on rollback rewin | conflicts(17) | 2/0 | 17f, 361+, 10- | fix(games): reset phase observer on rollback rewind (+1 more) |
| conflicts | `feature/falcon-animation-coverage` | `—` | 1 | 0 | 2026-09-10 feat(games): retain Falcon crouch and aerial-back  | conflicts(2) | 1/0 | 6f, 3281+, 3- | feat(games): retain Falcon crouch and aerial-back locomotion clips |
| conflicts | `feature/f41-ground-chart` | `—` | 1 | 0 | 2026-09-10 feat(games): S2 partial macro-free statig crouch c | conflicts(3) | 1/0 | 5f, 338+ | feat(games): S2 partial macro-free statig crouch chart |
| conflicts | `feature/falcon-locomotion-ingest` | `—` | 2 | 0 | 2026-09-10 feat(games): retain PM attributes page in Falcon p | conflicts(4) | 1/1 | 25f, 14894+, 5- | feat(games): retain PM attributes page in Falcon provenance (+1 more) |
| conflicts | `astra/game-runtime` | `~/projects/hafley-rs-game-runtime` | 104 | 8 | 2026-09-07 docs: record production Falcon forward air accepta | conflicts(5) | 104/0 | 358f, 85727+, 127- | docs: record production Falcon forward air acceptance (+5 more) |
| conflicts | `fix/native-codex-thread-start` | `—` | 1 | 0 | 2026-08-22 fix(boop): observe native Codex thread startup | conflicts(6) | 1/0 | 6f, 257+, 17- | fix(boop): observe native Codex thread startup |
| conflicts | `lab/tmux-process-env-terra` | `—` | 2 | 0 | 2026-08-21 boop: project native child completion events | conflicts(10) | 2/0 | 14f, 1723+, 18- | boop: project native child completion events (+1 more) |
| conflicts | `codex/harness-session-addressing` | `—` | 3 | 0 | 2026-08-21 fix(boop): prevent false child delivery receipts | conflicts(15) | 3/0 | 23f, 1610+, 326- | fix(boop): prevent false child delivery receipts (+2 more) |
| conflicts | `feature/lazy-codex-control-broker` | `—` | 1 | 0 | 2026-08-21 feat(boop): add lazy native Codex control broker | conflicts(27) | 1/0 | 32f, 1342+, 239- | feat(boop): add lazy native Codex control broker |
| conflicts | `backup/db-convoy-prerebase` | `—` | 2 | 0 | 2026-08-20 fix(boop): one transcript sync pass across concurr | conflicts(13) | 2/0 | 15f, 1304+, 87- | fix(boop): one transcript sync pass across concurrent readers (+1 more) |
| conflicts | `fix/caller-identity-rung` | `~/projects/sprefa-worktrees/hafley-identity` | 5 | 0 | 2026-08-20 docs: caller-identity-rung report | conflicts(8) | 5/0 | 10f, 931+, 79- | docs: caller-identity-rung report (+4 more) |
| conflicts | `feature/acp-all-harnesses` | `—` | 2 | 0 | 2026-08-20 issues: boop-process epic records the ACP flip (1f | conflicts(9) | 2/0 | 12f, 638+, 60- | issues: boop-process epic records the ACP flip (1fbc69e) (+1 more) |
| conflicts | `fix/boop-opencode-acp-channel` | `—` | 1 | 0 | 2026-08-19 fix(boop): use opencode ACP channel | conflicts(7) | 1/0 | 8f, 507+, 447- | fix(boop): use opencode ACP channel |
| conflicts | `fix/boop-opencode-certainty` | `—` | 1 | 0 | 2026-08-19 fix(boop): preserve OpenCode failure evidence | conflicts(10) | 1/0 | 12f, 1640+, 131- | fix(boop): preserve OpenCode failure evidence |
| conflicts | `fix/agent-graph-model-contract` | `—` | 1 | 0 | 2026-08-19 boop: project model preset metadata in agent graph | conflicts(4) | 1/0 | 7f, 80+, 91- | boop: project model preset metadata in agent graph |
| conflicts | `refactor/boop-harness-identity-rungs` | `—` | 1 | 0 | 2026-08-18 refactor boop identity rungs into harnesses | conflicts(5) | 1/0 | 5f, 128+, 13- | refactor boop identity rungs into harnesses |
| conflicts | `fix/boop-wait-parent` | `—` | 1 | 0 | 2026-08-17 boop: decouple foreground waits from coordinators | conflicts(4) | 1/0 | 7f, 109+, 34- | boop: decouple foreground waits from coordinators |
| superseded | `chore/boop-typespec-map` | `—` | 1 | 0 | 2026-09-25 plans: boop typespec map report | clean | 0/1 | 1f, 492+ | plans: boop typespec map report |
| superseded | `codex/main-attribution` | `~/projects/hafley-rs-wt/main-codex-attribution` | 1 | 53 | 2026-09-24 Add sqlite-ext collector reattach for reopened con | clean | 0/1 | 9f, 815+, 47- | Add sqlite-ext collector reattach for reopened connections |
| superseded | `feature/ryi-kotlin-fast-one-query` | `—` | 1 | 0 | 2026-09-23 Reuse Kotlin SCM arena for fast and module facts | conflicts(11) | 0/1 | 11f, 170+, 20- | Reuse Kotlin SCM arena for fast and module facts |
| superseded | `feature/ryi-d2-scc-tier` | `—` | 1 | 0 | 2026-09-23 ryi: layer D2 boards by SCC | clean | 0/1 | 3f, 471+, 83- | ryi: layer D2 boards by SCC |
| superseded | `feature/ryi-scip-external-receipt` | `—` | 1 | 0 | 2026-09-23 Expose SCIP external reference identities with cov | conflicts(4) | 0/1 | 11f, 371+, 3- | Expose SCIP external reference identities with coverage receipt |
| superseded | `feat/graph-callers-arm` | `—` | 1 | 0 | 2026-09-20 graph: add callers integration test | conflicts(1) | 0/1 | 4f, 126+, 2- | graph: add callers integration test |
| superseded | `worktree-agent-a01074abe4f4d44ff` | `~/projects/hafley-rs/.claude/worktrees/agent-a01074abe4f4d44ff` | 1 | 0 | 2026-09-18 wip(a01074abe4f4d44ff): lane work preserved before | conflicts(2) | 0/1 | 3f, 160+, 6- | wip(a01074abe4f4d44ff): lane work preserved before machine-load stop |
| superseded | `worktree-agent-ab1a047894a2f5997` | `~/projects/hafley-rs/.claude/worktrees/agent-ab1a047894a2f5997` | 1 | 0 | 2026-09-18 wip(ab1a047894a2f5997): lane work preserved before | conflicts(4) | 0/1 | 8f, 230+, 4- | wip(ab1a047894a2f5997): lane work preserved before machine-load stop |
| superseded | `feature/extract-lane-b-meter` | `—` | 1 | 0 | 2026-09-17 wip(extract): lane b-meter state at opencode death | conflicts(1) | 0/1 | 1f, 41+, 20- | wip(extract): lane b-meter state at opencode death |
| superseded | `docs/omp-smoke` | `—` | 1 | 0 | 2026-09-14 docs(boop): omp smoke lane receipt | clean | 0/1 | 1f, 6+ | docs(boop): omp smoke lane receipt |
| superseded | `feature/omp-harness-b` | `—` | 1 | 0 | 2026-09-14 feat(boop): omp transcript readers and ingest | conflicts(2) | 0/1 | 2f, 799+, 11- | feat(boop): omp transcript readers and ingest |
| superseded | `test/agentty-probe` | `—` | 1 | 0 | 2026-09-14 test(boop-harness): land agentty probe fixtures | clean | 0/1 | 4f, 249+ | test(boop-harness): land agentty probe fixtures |
| superseded | `test/goose-probe` | `—` | 1 | 0 | 2026-09-14 test(boop-harness): land goose probe fixtures | clean | 0/1 | 4f, 403+ | test(boop-harness): land goose probe fixtures |
| superseded | `test/omp-harness-probe` | `—` | 1 | 0 | 2026-09-14 test(boop-harness): land omp session and ACP fixtu | clean | 0/1 | 4f, 358+ | test(boop-harness): land omp session and ACP fixtures |
| superseded | `refactor/f41-redux-controller-dedupe` | `—` | 1 | 0 | 2026-09-11 refactor(games): express controller tick through r | conflicts(3) | 0/1 | 4f, 211+, 195- | refactor(games): express controller tick through redux Slice |
| superseded | `refactor/f41-action-state-dedupe` | `—` | 1 | 0 | 2026-09-11 refactor(games): group controller action and frame | conflicts(3) | 0/1 | 3f, 35+, 27- | refactor(games): group controller action and frame into ActionState |
| superseded | `refactor/f41-dedupe-crouch-chart` | `—` | 1 | 0 | 2026-09-11 refactor(games): dedupe crouch onto live ground ma | conflicts(3) | 0/1 | 5f, 66+, 338- | refactor(games): dedupe crouch onto live ground machine |
| superseded | `chore/f41-game-combat-stage2-status` | `—` | 1 | 0 | 2026-09-11 docs(games): advance game-combat to stage 2 | conflicts(10) | 0/1 | 10f, 138+, 128- | docs(games): advance game-combat to stage 2 |
| superseded | `feature/f41-pigeon-combat-redux` | `—` | 1 | 0 | 2026-09-11 feat(games): wire game-combat into Pigeon replay s | conflicts(4) | 0/1 | 5f, 222+, 32- | feat(games): wire game-combat into Pigeon replay state |
| superseded | `feature/gem38f-ascii-scenes2` | `—` | 1 | 0 | 2026-09-11 docs(games): add ascii combat resolution scenes to | conflicts(1) | 0/1 | 1f, 105+ | docs(games): add ascii combat resolution scenes to struct fields |
| superseded | `fix/f41-dog-status-binding-truth` | `—` | 1 | 0 | 2026-09-11 fix(games): separate Dog role binding from phase a | conflicts(3) | 0/1 | 3f, 207+, 99- | fix(games): separate Dog role binding from phase and live status |
| superseded | `feature/f41-dog-complete-locomotion` | `—` | 1 | 0 | 2026-09-11 feat(games): bind Dog locomotion action roles | conflicts(12) | 0/1 | 21f, 9180+, 70- | feat(games): bind Dog locomotion action roles |
| superseded | `fix/f41-dog-status-tsp-source` | `—` | 1 | 0 | 2026-09-11 feat(games): report Dog action status beside Pigeo | conflicts(4) | 0/1 | 5f, 886+, 5- | feat(games): report Dog action status beside Pigeon |
| superseded | `feature/f41-character-action-roles` | `—` | 1 | 0 | 2026-09-11 feat(games): generate character animation action-r | conflicts(6) | 0/1 | 11f, 938+, 23- | feat(games): generate character animation action-role bindings |
| superseded | `feature/f41-character-rules-codegen` | `—` | 1 | 0 | 2026-09-11 feat(games): generate character Rules constructors | conflicts(4) | 0/1 | 7f, 451+, 42- | feat(games): generate character Rules constructors |
| superseded | `refactor/f41-wire-pigeon-dog-generator` | `—` | 3 | 0 | 2026-09-10 fix(games): return path-specific smash-import usag | conflicts(7) | 0/3 | 9f, 5623+, 171- | fix(games): return path-specific smash-import usage errors (+2 more) |
| superseded | `refactor/f41-coyote-to-dog` | `—` | 1 | 0 | 2026-09-10 refactor(games): rename Common Coyote runtime name | conflicts(22) | 0/1 | 22f, 11+, 11- | refactor(games): rename Common Coyote runtime namespace to Dog |
| superseded | `fix/f41-coyote-ingest-review` | `—` | 2 | 0 | 2026-09-10 fix(games): correct and complete Common Coyote ing | conflicts(3) | 0/2 | 24f, 22284+ | fix(games): correct and complete Common Coyote ingestion proof (+1 more) |
| superseded | `fix/private-pigeon-f41` | `—` | 1 | 0 | 2026-09-10 fix(games): align Pigeon phase tests with 14-state | conflicts(6) | 0/1 | 6f, 11+, 11- | fix(games): align Pigeon phase tests with 14-state projection |
| superseded | `refactor/f41-neutral-mechanics-codegen` | `—` | 1 | 0 | 2026-09-10 refactor(games): generate neutral ftCommon mechani | conflicts(5) | 0/1 | 7f, 1166+, 539- | refactor(games): generate neutral ftCommon mechanics contract |
| superseded | `feature/f41-pm36-coyote-ingest` | `—` | 1 | 0 | 2026-09-10 feat(games): ingest PM3.6 corpus as Common Coyote  | conflicts(1) | 0/1 | 22f, 22145+ | feat(games): ingest PM3.6 corpus as Common Coyote catalog |
| superseded | `feature/f41-ftcommon-rust-port` | `—` | 2 | 0 | 2026-09-10 refactor(games): translate ftCommon callbacks to o | conflicts(13) | 0/2 | 19f, 1755+, 96- | refactor(games): translate ftCommon callbacks to ordered typed effects (+1 more) |
| superseded | `feature/glm53f-port-step-contract` | `—` | 2 | 0 | 2026-09-10 fix(games): step check re-executes gates and drops | conflicts(3) | 0/2 | 7f, 464+ | fix(games): step check re-executes gates and drops lifecycle-chart art (+1 more) |
| superseded | `fix/f41-falcon-source-codegen-review` | `—` | 1 | 0 | 2026-09-10 refactor(games): collapse duplicated Falcon source | conflicts(2) | 0/1 | 3f, 68- | refactor(games): collapse duplicated Falcon source-rule output |
| superseded | `chore/f41-falcon-selection-review` | `—` | 1 | 0 | 2026-09-10 docs(games): derive Falcon selection sources for s | clean | 0/1 | 1f, 263+ | docs(games): derive Falcon selection sources for seven unselected clip |
| superseded | `fix/f41-status-main-harmonic` | `—` | 1 | 0 | 2026-09-10 fix(games): observe conditional Falcon selections  | conflicts(7) | 0/1 | 7f, 226+, 91- | fix(games): observe conditional Falcon selections and share phase iden |
| superseded | `chore/f41-ui-tc39` | `—` | 1 | 0 | 2026-09-10 docs(games): classify game-ui router proposal and  | conflicts(9) | 0/1 | 9f, 173+, 101- | docs(games): classify game-ui router proposal and record UI/input/depl |
| superseded | `chore/f41-games-roadmap-today` | `—` | 1 | 0 | 2026-09-10 docs(games): record 2026-09-10 structural gates | conflicts(6) | 0/1 | 6f, 126+, 93- | docs(games): record 2026-09-10 structural gates |
| superseded | `fix/f41-statechart-ui` | `—` | 1 | 0 | 2026-09-10 feat(games): make Falcon debug overlay readable on | conflicts(3) | 0/1 | 4f, 260+, 26- | feat(games): make Falcon debug overlay readable on desktop and mobile |
| dirty-only | `feature/ryi-codeql-baseline` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-codeql-baseline` | 0 | 1 | 2026-09-26 sprefa-extract: cap baseline memory and clean data | — | — |  | worktree edits only |
| dirty-only | `feature/ryi-write-side-2` | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-write-side-2` | 0 | 1 | 2026-09-26 record soopy batch dogfood defects | — | — |  | worktree edits only |
| dirty-only | `perf/boop-graph-sqlite-only` | `~/projects/hafley-rs/.boop-worktrees/perf/boop-graph-sqlite-only` | 0 | 6 | 2026-09-23 perf(boop-store): incremental session-graph reader | — | — |  | worktree edits only |
| dirty-only | `feat/cleave-on-facts` | `~/projects/hafley-rs/.claude/worktrees/agent-a9318b94c18ea8bfa` | 0 | 7 | 2026-09-21 manual: respell Mutate -> Cleave in doc-comment pr | — | — |  | worktree edits only |
| dirty-only | `feat/observe-event-sums` | `~/projects/hafley-rs/.boop-worktrees/main` | 0 | 24 | 2026-09-20 observe: span_counts_by_field | — | — |  | worktree edits only |
| dirty-only | `worktree-extract-fixes` | `~/projects/hafley-rs/.claude/worktrees/extract-fixes` | 0 | 16 | 2026-09-18 docs(extract): lane DV diff verb report; close ext | — | — |  | worktree edits only |
| dirty-only | `(detached f98130cd)` | `~/projects/hafley-rs/.worktrees/origin-main` | 0 | 1 | 2026-08-25 build: cut the workspace gate from 125s to 43s, an | — | — |  | worktree edits only |

### hafley-rs main checkout: uncommitted files by directory

| dir | files | newest mtime | < 2h (likely another agent in progress) |
| --- | --- | --- | --- |
| `chat_log/20260926.1.ryi-overnight-sol6-lanes-codeql-typespec-loadout.md` | 1 | 2026-09-26 12:23 | yes |
| `plans/2026-09-26-ryi-serve-memory-and-contracts.DISCUSSION.md` | 1 | 2026-09-26 11:59 | yes |
| `chat_log/20260926.0.boop-xterm-lift-wave3-and-cards.md` | 1 | 2026-09-26 11:49 | yes |
| `TASKS/scm-has-kind-list-sol6.BRIEF.md` | 1 | 2026-09-26 11:39 | yes |
| `TASKS/ryi-edit-soopy-bugs-sol6.BRIEF.md` | 1 | 2026-09-26 08:53 |  |
| `TASKS/ryi-serve-result-sol6.BRIEF.md` | 1 | 2026-09-26 08:53 |  |
| `TASKS/ryi-sqlite-bind-sol6.BRIEF.md` | 1 | 2026-09-26 08:53 |  |
| `.` | 2 | 2026-09-26 08:47 |  |
| `TASKS/ryi-src-review-sol6max.BRIEF.md` | 1 | 2026-09-26 08:47 |  |
| `TASKS/ryi-sqlite-writer-sol6.BRIEF.md` | 1 | 2026-09-26 07:04 |  |
| `TASKS/ryi-ts-round3-sol6.BRIEF.md` | 1 | 2026-09-26 07:04 |  |
| `TASKS/ryi-rust-round3-sol6.BRIEF.md` | 1 | 2026-09-26 07:04 |  |
| `TASKS/ryi-memory-sqlite-sol6.BRIEF.md` | 1 | 2026-09-26 04:46 |  |
| `TASKS/ryi-ts-vs-codeql-sol6.BRIEF.md` | 1 | 2026-09-26 02:14 |  |
| `TASKS/ryi-rust-vs-codeql-sol6.BRIEF.md` | 1 | 2026-09-26 02:14 |  |
| `TASKS/ryi-vertical-inproc-sol6.BRIEF.md` | 1 | 2026-09-26 02:04 |  |
| `TASKS/ryi-vertical-sol6.BRIEF.md` | 1 | 2026-09-26 00:51 |  |
| `crates/sprefa-extract/src` | 1 | 2026-09-26 00:43 |  |
| `TASKS/ryi-ts-speed-sol6.BRIEF.md` | 1 | 2026-09-26 00:38 |  |
| `TASKS/ryi-rust-accuracy-sol6.BRIEF.md` | 1 | 2026-09-26 00:38 |  |
| `TASKS/ryi-codeql-baseline-sol6.BRIEF.md` | 1 | 2026-09-26 00:16 |  |
| `chat_log/20260925.2.ryi-read-scm-ladder-codeql-clap-sol6-lanes.md` | 1 | 2026-09-25 23:43 |  |
| `TASKS/ryi-write-side-2-sol6.BRIEF.md` | 1 | 2026-09-25 23:39 |  |
| `TASKS/ryi-read-arena-sol6.BRIEF.md` | 1 | 2026-09-25 23:39 |  |
| `chat_log/20260925.1.ryi-milestone-stack-fast-slow-graph-perf.md` | 1 | 2026-09-25 13:59 |  |
| `chat_log/20260925.0.ryi-ratchet-clap-cleanup-and-same-file-fix.md` | 1 | 2026-09-25 01:22 |  |
| `crates/boop/plans` | 3 | 2026-09-24 22:22 |  |
| `crates/sprefa-extract/plans` | 2 | 2026-09-24 16:59 |  |
| `chat_log/20260924.0.ryi-scip-source-manifest-closeout.md` | 1 | 2026-09-24 13:29 |  |
| `TASKS/scm-rust-shared-tree.BRIEF.md` | 1 | 2026-09-23 17:53 |  |
| `issues/scm-kotlin-front-end` | 1 | 2026-09-23 17:15 |  |
| `issues/scm-oxc-front-end` | 1 | 2026-09-23 17:15 |  |
| `issues/scm-rust-front-end` | 1 | 2026-09-23 17:15 |  |
| `issues/scm-language-frontends` | 1 | 2026-09-23 17:14 |  |
| `chat_log/20260922.0.ryi-fast-scm-arc-and-next-lowering.md` | 1 | 2026-09-22 14:48 |  |
| `TASKS/lane-hafley-scm-finish-arc.BRIEF.md` | 1 | 2026-09-22 01:58 |  |
| `TASKS/lane-hafley-scm-rust-call-cutover.BRIEF.md` | 1 | 2026-09-22 01:10 |  |
| `TASKS/lane-hafley-scm-rust-syn-boundary.BRIEF.md` | 1 | 2026-09-22 00:55 |  |
| `TASKS/lane-hafley-scm-neovim-predicates.BRIEF.md` | 1 | 2026-09-22 00:45 |  |
| `.claude/skills` | 2 | 2026-09-20 15:45 |  |
| `TASKS/lane-lab-bakeoff-aider.BRIEF.md` | 1 | 2026-09-20 14:22 |  |
| `TASKS/lane-lab-bakeoff-interface.BRIEF.md` | 1 | 2026-09-20 14:06 |  |
| `TASKS/lane-rename-abstain-record.BRIEF.md` | 1 | 2026-09-20 13:53 |  |
| `plans/2026-09-20-sqlite-bulk-trigger.BRIEF.md` | 1 | 2026-09-20 13:34 |  |
| `TASKS/lane-rename-path-union.BRIEF.md` | 1 | 2026-09-20 12:43 |  |
| `TASKS/lane-scm-relations-doc.BRIEF.md` | 1 | 2026-09-20 12:42 |  |
| `TASKS/lane-rename-stop-line-numbers.BRIEF.md` | 1 | 2026-09-20 01:56 |  |
| `TASKS/lane-query-predicate-leak.BRIEF.md` | 1 | 2026-09-20 01:53 |  |
| `TASKS/lane-scm-lower-astgrep.BRIEF.md` | 1 | 2026-09-20 01:22 |  |
| `TASKS/lane-lang-kind-ids-and-kotlin-decline.BRIEF.md` | 1 | 2026-09-19 22:01 |  |
| `TASKS/lane-default-families.BRIEF.md` | 1 | 2026-09-19 18:45 |  |
| `plans/briefs` | 11 | 2026-09-19 17:26 |  |
| `plans/2026-09-14-pi-harness.PLAN.md` | 1 | 2026-09-19 17:26 |  |
| `plans/2026-09-14-otel-ingest-research.md` | 1 | 2026-09-19 17:26 |  |
| `docs/6_boop-tag-batch-read` | 3 | 2026-09-19 17:26 |  |
| `crates/boop/docs` | 1 | 2026-09-19 17:26 |  |
| `crates/boop-proc/src` | 1 | 2026-09-19 17:26 |  |
| `crates/boop-mux/plans` | 1 | 2026-09-19 17:26 |  |
| `TASKS/pane-truth-cli-flash4-residue.patch` | 1 | 2026-09-19 17:26 |  |
| `TASKS/lane-local-binding-inference.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/lane-list-liveness.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/lane-extract-lines-flag.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/lane-cst-out-of-default.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/context-cap.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-tui-revive.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-ps.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-ps-activity.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-progress-warning.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-pane-truth-store.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-pane-truth-cli.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-observation-trace.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-luna-visible-tui.REVIEW-1.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-luna-visible-tui.CONTINUE.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-luna-visible-tui.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-ghcacher-pr.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-ghcache-review.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-ghcache-adapter-final.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-f41-handoff.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `TASKS/boop-batch-pane-pids.BRIEF.md` | 1 | 2026-09-19 17:26 |  |
| `hat_log/LATEST.md` | 1 | deleted |  |

## Reapable worktrees

Clean worktree (dirty=0) and either 0 commits ahead of main or every patch already on main. Reaping them removes only the checkout directory. Branches with superseded commits can be deleted too.

| repo | worktree | branch | ahead | reason |
| --- | --- | --- | --- | --- |
| instant | `~/projects/worktrees/instant-tauri-request-signals` | `refactor/tauri-request-signals` | 1 | superseded, clean |
| instant | `~/projects/instant-ci-luna/instant` | `fix/ci-summary-adapter` | 0 | 0 ahead, clean |
| instant | `~/projects/instant-worktrees/boop-revive-attribution` | `fix/boop-revive-attribution` | 0 | 0 ahead, clean |
| instant | `~/projects/instant-worktrees/main-issues` | `chore/interaction-issue-worktree` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/asq-reading-hold` | `fix/asq-reading-hold` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/asq-recent-scroll` | `fix/asq-recent-scroll` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/asq-tab-centering` | `fix/asq-tab-centering` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/asq-tool-squares` | `fix/asq-tool-squares` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/omp-turn-attribution-terra` | `fix/omp-turn-attribution-terra` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.boop-worktrees/fix/omp-turn-matcher-parity-terra` | `fix/omp-turn-matcher-parity-terra` | 0 | 0 ahead, clean |
| instant | `~/projects/instant/.claude/worktrees/proc-seam` | `worktree-proc-seam` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/grapht-cyto-dark` | `fix/grapht-cyto-dark` | 1 | superseded, clean |
| hafley-rxjs | `~/projects/hafley-rxjs-md-focus-e2e` | `fix/md-focus-reentry` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/chore/path-kernel-review-3` | `chore/path-kernel-review-3` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/chore/signal-grid-buy-site` | `chore/signal-grid-buy-site` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/chore/signal-grid-live-demos-research` | `chore/signal-grid-live-demos-research` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feat/signals-query-visibility` | `feat/signals-query-visibility` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-docs` | `feature/grapht-docs` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-pages-site` | `feature/grapht-pages-site` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/grapht-seq-fixture` | `feature/grapht-seq-fixture` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/md-echarts-fence` | `feature/md-echarts-fence` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-bound-panel` | `feature/signal-grid-bound-panel` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-docs-tree` | `feature/signal-grid-docs-tree` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-header-groups` | `feature/signal-grid-header-groups` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-logtape` | `feature/signal-grid-logtape` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-grid-stress-receipts` | `feature/signal-grid-stress-receipts` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/feature/signal-scan-expand` | `feature/signal-scan` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-doc-names` | `fix/signal-grid-doc-names` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-group-rows` | `fix/signal-grid-group-rows` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-kill-jsdom` | `fix/signal-grid-kill-jsdom` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-resize-flex` | `fix/signal-grid-resize-flex` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-transpose-cells` | `fix/signal-grid-transpose-cells` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-transpose-render` | `fix/signal-grid-transpose-render` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.boop-worktrees/fix/signal-grid-wire-site` | `fix/signal-grid-wire-site` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.worktrees/bewpp-package` | `feature/bewpp-package` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.worktrees/d2-types` | `fix/d2-types` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/hafley-rxjs/.worktrees/devtool-types` | `fix/devtool-types` | 0 | 0 ahead, clean |
| hafley-rxjs | `~/projects/instant-worktrees/md-preview` | `fix/md-preview-performance` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a01074abe4f4d44ff` | `worktree-agent-a01074abe4f4d44ff` | 1 | superseded, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-ab1a047894a2f5997` | `worktree-agent-ab1a047894a2f5997` | 1 | superseded, clean |
| hafley-rs | `~/.agent/lanes/feature-watch-the-watchman/baseline` | `(detached)` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-turn-remind-integration` | `integrate/turn-remind-20260921` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/ci-luna-sequence` | `fix/ci-luna-sequence` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/cq` | `(detached)` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/extract-check` | `(detached)` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/extract-oracle-paths-test` | `(detached)` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/extract-post-move-fix` | `fix/extract-post-move-20260914` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs-wt/ryi` | `feat/ryi-rename` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/chore/flash-review-cleanups` | `chore/flash-review-cleanups` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/chore/lang-kind-ids-and-kotlin-decline` | `chore/lang-kind-ids-and-kotlin-decline` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/chore/ryi-stale-scip-glm-review` | `chore/ryi-stale-scip-glm-review` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/chore/ryi-stale-scip-opus55-review` | `chore/ryi-stale-scip-opus55-review` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feat/sqlite-bulk-trigger` | `feat/sqlite-bulk-trigger` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/extract-lines-flag` | `feature/extract-lines-flag` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/hafley-scm-finish-arc` | `feature/hafley-scm-finish-arc` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/hafley-scm-neovim-predicates` | `feature/hafley-scm-neovim-predicates` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-default-families` | `feature/ryi-default-families` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-memory-sqlite` | `feature/ryi-memory-sqlite` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-project-graph` | `feature/ryi-reject-stale-scip` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-ratchet` | `feature/ryi-ratchet` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-read-arena` | `feature/ryi-read-arena` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-rust-accuracy` | `feature/ryi-rust-accuracy` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-rust-vs-codeql` | `feature/ryi-rust-vs-codeql` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-ts-speed` | `feature/ryi-ts-speed` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-ts-vs-codeql` | `feature/ryi-ts-vs-codeql` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-vertical` | `feature/ryi-vertical` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/ryi-vertical-inproc` | `feature/ryi-vertical-inproc` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/scm-rust-df-rows` | `feature/scm-rust-df-rows` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/feature/scm-rust-front-end` | `feature/scm-rust-front-end` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/fix/boop-tmux-ci` | `fix/boop-tmux-ci` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/improvement/cst-out-of-default` | `improvement/cst-out-of-default` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/perf/boop-graph-incremental` | `perf/boop-graph-incremental` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/perf/boop-graph-sqlite-only-luna6` | `perf/boop-graph-sqlite-only-luna6` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.boop-worktrees/review/astgrep-multinode` | `review/astgrep-multinode` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a4a77ceafe85006cd` | `ryi/read-arena` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a4c414dcd54abe43a` | `worktree-agent-a4c414dcd54abe43a` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a560967f6ae0da66e` | `ryi/slow-oracle` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a58de31f9fb5dea9b` | `ryi/fast-throughput` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a7f8ac2522db9437c` | `ryi/cross-crate-move` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-a9f1d658cd3936544` | `ryi/read-side-scm` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-aa1a839c909c2f4cf` | `feat/hafley-scm-rust-call` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-aa6e9eaa969f00041` | `ryi/rust-mod-rows` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-ab5c44d0abba0bfe0` | `ryi/inputs-cli` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-ad4be7db1f2be233c` | `ryi/graph-foundation` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.claude/worktrees/agent-af8beb4322db4b8f6` | `ryi/write-side` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.worktrees/agent-squares` | `feat/agent-squares` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/hafley-rs/.worktrees/sprefa-extract` | `feature/sprefa-extract-crate` | 0 | 0 ahead, clean |
| hafley-rs | `~/projects/instant-ci-luna/hafley-rs-frozen` | `(detached)` | 0 | 0 ahead, clean |
