# Waterfall virtualization: build-vs-buy record (lab/waterfall-perf)

Decision: window the existing hand-rolled SVG with @tanstack/react-virtual
(already a dependency, already drives treetable.tsx); keep d3-scale/d3-brush.
Zero new installs.

## Candidates

Gate: bounds DOM by viewport. Only ECharts, d3+canvas, and windowing pass it;
the canvas pair costs a parallel theming pipeline (canvas cannot read the
app's CSS variables), manual hit-testing, and a rewrite of both e2e specs,
for a strip that shows ~6 lanes in 240px.

| candidate | bounds DOM by viewport | new install | brush | CSS-var theming | react 19 | keeps tests |
|---|---|---|---|---|---|---|
| vis-timeline | no (DOM per item; docs cap "a few hundreds") | 75.8 MB + 10 peers incl moment | yes | yes | no (react-vis-timeline dead 2022, peer react ^16) | partly |
| react-calendar-timeline | partly (x only, lanes unvirtualized) | 1.7 MB + interactjs, dayjs | no | partly | RC-tag peer only | no |
| visx | no (renders what you map; no windowing layer) | 358 KB | yes | yes | yes | partly |
| Observable Plot | no (SVG per mark; a cited 2026 blog claims canvas, the official docs say it returns an SVG element) | 1.5 MB | no | no | not a react lib | no |
| ECharts custom series | yes (canvas) | 58.9 MB | yes (dataZoom) | no | third-party bridge | no |
| d3 + canvas | yes (canvas) | 0 | yes | no | manual | no |
| windowed SVG + react-virtual | yes | 0 | yes | yes | yes | yes |

Sizes are npm unpacked install size; bundlephobia/packagephobia were
unreachable from the lane sandbox, so gzipped figures are not quoted.

visx note: strongest library of the set and still a lateral move; it is
react bindings over d3 primitives already present and does no windowing.
Right choice from zero; not a remedy here.

Price paid for windowing: ~90 owned lines; no free zoom/pan/tooltip layer;
ticks inside a visible lane decimate per pixel column rather than window. If
one lane ever needs tens of thousands of simultaneously visible marks,
decimation stops being honest and d3+canvas becomes correct; scales and
brush carry over unchanged at that escalation.

## The four amplifiers and their fixes

| amplifier | fix | location |
|---|---|---|
| full-history default range | defaultRange opens on the newest 40 sessions (count-based, controls the node budget directly; wall-clock windows show zero after idle nights and hundreds during fan-outs) | 0_waterfall.ts:61 |
| unwindowed bars/labels | useVirtualizer over lanes, 6-lane scroller | 4_Waterfall.tsx:196 |
| unwindowed ticks | decimateTicks, one per pixel column, highest-ranked type wins | 0_waterfall.ts:110 |
| IPC read fan-out | effect keys on the lane window, never the whole range | 4_Waterfall.tsx:245 |

Also: overview rects became one binsPath step area (one element at any
history size); brush ignores programmatic moves (!event.sourceEvent) so the
initial placement cannot freeze the default selection.

## Measured

| metric | small fixture | stress 300x50 | unwindowed equivalent |
|---|---|---|---|
| DOM nodes | 160 (budget 244) | 547 (bound 700) | ~30,600 |
| bars | 4 | 9 (bound 14) | 300 |
| ticks | 8 | 63 (bound 150) | 15,000 |
| IPC reads | 4 | 9 (bound 20) | 300 |

Gates at merge (coordinator re-ran all three): vitest harnessTrace 150/150;
tsc with only the pre-existing src/plugin.test.ts(69) CtxItem error;
playwright waterfall + dock-strip 5/5 incl the stress budget test.

Operational note from the lane: playwright.config.ts uses port 4173 with
reuseExistingServer true, so a stale vite there silently tests another
tree's sources; playwright.waterfall.config.ts (port 4198, no reuse) is the
safe standing command for this spec.
