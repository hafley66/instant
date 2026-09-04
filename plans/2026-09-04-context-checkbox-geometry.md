# instant/terminal: gutter checkboxes on the turn-debug paint model

## TOC
1. Defect
2. The model to reuse
3. Ownership
4. Deliverable, in order
5. Receipts (red then green)
6. Validation commands
7. Laws

## 1. Defect

The structured checkboxes (`.term-context-structured-check`, table rows,
list items, headings) and the hover checkbox wobble, lag, vanish during
scroll, and sometimes never come back. The turn-attribution debug overlay
(`src/0_turnDebugOverlay.ts`, toggle `#turn-debug-toggle`) on the same rows
is exact and instant. The two do not share a code path.

| checkbox path today (`src/1a_terminalContextQueue.ts`) | line | why it wobbles |
|---|---|---|
| positions from `anchors.elementForBufferRow(row).getBoundingClientRect()` | `paintSelections` | reads DOM rects of xterm row elements that xterm re-creates on every parsed write |
| `debounceTime(650)` after any viewport motion, `gutter.hidden = true` meanwhile | constructor `anchorSubscription` | the gutter blinks off for 650 ms on every scroll tick |
| `projection_grace_ms = 2000` keeps stale boxes, then reaps by `confirmedAt` | `paintSelections` | boxes linger on old rows, then drop |
| `checkboxes.size > 512` reaper | `paintSelections` | unrelated to what is on screen |
| `1c_terminalHoverCheck.ts` `show` | rect math of an anchor element | same rect dependency |
| `1d_terminalTurnMarks.ts` `paint` | `debounceTime(150)` + anchor rects | same, plus a lag |

## 2. The model to reuse (`src/0_turnDebugOverlay.ts:96-239`)

```
schedule()  on projection.changes, term.onScroll, term.onResize, term.onWriteParsed, pointermove
paint()     one requestAnimationFrame; never debounced; never hides
row -> y    top = screenRect.top - hostRect.top + (bufferRow - viewportY) * cellHeight
            cellHeight = screenRect.height / term.rows
shift       markScan() pins an xterm marker at the newest projection; bufferShift() =
            scanLine - marker.line; shiftSpans(projection.visible, bufferShift()) moves
            every span by how far scrollback trimmed since the scan
pointer     bufferRowAtClientY(clientY) by geometry, never by hit target
```

No DOM rect of a row element is read. No debounce. No grace. No hidden gutter.

## 3. Ownership

Owned (edit freely):
- `src/1a_terminalContextQueue.ts` (keep under 500 lines: move painting out)
- new `src/1a2_terminalContextGutter.ts` (or the name you pick with the same prefix): the checkbox painter
- new `src/0_terminalRowGeometry.ts`: `markScan`/`bufferShift`/`bufferRowAtClientY`/row-to-y extracted from the debug overlay, imported by both
- `src/0_turnDebugOverlay.ts` only to import the extracted geometry; its behaviour and its e2e (`e2e/term-turn-attribution-real.spec.ts`, snapshots) must not change
- `src/1c_terminalHoverCheck.ts`, `src/1d_terminalTurnMarks.ts`: reposition on the same painter
- `src/styles.css`: the `.term-context-*` rules only
- `src/terminal.ts`: wiring lines only
- `e2e/term-context-checkbox.spec.ts` (new), unit tests beside the modules

Not owned: `src/00b_terminalLineAnchors.ts`, `src/0_terminalTurnVisibility.ts`,
`src/00_terminalTurnRegions.ts`, `src/1b_terminalContextSync.ts`, `src-tauri/`.
`selectableBufferRow` (buffer row of a region line) stays the source of which row a
checkbox belongs to; only where that row is on screen changes.

## 4. Deliverable, in order

1. `e2e/term-context-checkbox.spec.ts`, red against HEAD (`72cbaf8`). Commit it alone;
   paste the failing playwright output into the commit body.
2. `src/0_terminalRowGeometry.ts` extracted from the debug overlay; debug overlay imports
   it; `e2e/term-turn-attribution-real.spec.ts` still green (snapshots unchanged).
3. The checkbox painter on that geometry. One `schedule()`/`paint()` pair driven by the
   four xterm signals + `projection.changes` + `anchors.visible` (for line text only).
   The `<input>` per selectable is keyed by selectable id and reused across paints; a
   selectable off screen is `hidden`, never removed and re-created while its region is
   still in `projection.visible`. Hover checkbox and marks reposition through the same
   `paint()`.
4. Spec green. Commit. Run every validation command below.
5. `boop beep parent "<3 lines: thread name, defect -> fix -> receipt, next move>" --as opus-checkbox-geometry`

## 5. Receipts (red then green)

`e2e/term-context-checkbox.spec.ts`, built on `openConversation` from
`e2e/term-turn-attribution-real.spec.ts` (harness fixture through
`window.__instantE2eNativeResults.boop_turns`), with one assistant turn whose `said`
holds a 3-row markdown table, a 3-item list, and an `## heading`. Assertions, each its
own `test`:

| case | input | expected | why this case exists |
|---|---|---|---|
| appears at once | render the turn | checkbox count = 3 table rows + 3 list items + 1 heading within 200 ms of the projection settling; no box `hidden` | today boxes arrive late or not at all |
| tracks a scroll | `__term.scroll(2)` | every box's `top` moves by exactly `2 * cellHeight` by the next frame; none `hidden` at any sample (poll 16 ms) | today the gutter hides for 650 ms |
| survives a write | write 4 more lines so the viewport scrolls | each box still sits on its row (compare `top` with `__term.point(row, 0).y` of the row whose text is the table row) | rows re-created by xterm dropped the rect |
| survives scrollback trim | write enough lines to exceed scrollback so `bufferShift()` is non-zero | boxes still on their rows | the debug overlay handles this; checkboxes must too |
| clicks queue the row | click the 2nd table-row box | `.term-context-queue-quote` has that row's text | end-to-end proof the reused geometry still hits the right selectable |
| hover box on the same model | `page.mouse.move` to a prose row | `.term-context-hover-check` visible, `top` equal to that row's `y` | the hover box shares the painter |

`cellHeight` and row `y` come from `window.__term.point(row, col)`; add a `__term` hook
in `e2e/term.tsx` only if one is missing.

## 6. Validation commands (run all, paste results in the parent hail)

```
corepack pnpm@10.12.4 exec tsc --noEmit
corepack pnpm@10.12.4 exec vitest run
corepack pnpm@10.12.4 exec playwright test e2e/term-context-checkbox.spec.ts e2e/term-context-hover.spec.ts e2e/term-word-select.spec.ts e2e/term-turn-attribution-real.spec.ts --reporter=line
corepack pnpm@10.12.4 run build
```

Never run `just dev` (AGENTS.md: the owner's instance is running). Use `just dev-safe`
only if a manual look is needed.

## 7. Laws

- Work in `~/projects/instant` on `main`; commit as you go; do not push.
- `AGENTS.md` applies: files under ~500 lines, no bespoke list/table UIs, no
  hand-rolled split panes.
- Prose in comments and commits: no em dashes; no `here is`/`below`/`the following`;
  never the words `provenance`, `substrate`, `load-bearing`, `regime`; no `honestly`,
  `grounded`, `distill`. `///` doc comments in the file's existing style.
- Every `boop` call carries `--as opus-checkbox-geometry`.
- Report to the parent with `boop beep parent ... --as opus-checkbox-geometry` when
  done or when blocked; blocked means: say what is blocked and what you finished.
