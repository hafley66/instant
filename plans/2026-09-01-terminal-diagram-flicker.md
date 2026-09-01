# Terminal diagram overlay flicker: diagnosis, repro, fix plan

Date: 2026-09-01. Lane: diagnosis only, no fix implemented. Base sha `01b70a9`.

Owned files: `src/0_terminalDiagrams.ts`, `src/0_terminalDiagrams.test.ts`, new
`e2e/term-diagram-flicker.spec.ts`, this plan.

## Summary

| Question | Answer |
| --- | --- |
| Flicker while typing | `onWriteParsed` / `viewportScrolled` hide the whole overlay root on every event, unconditionally. |
| Flicker while idle | The turn-visibility rescan loop re-locates projected fences every second; any row drift re-mints the DOM element because the element key encodes `fence.start`. |
| Which path re-creates elements | `paint()` element reuse keys only on `diagramElementKey()`, which includes `fence.start`. |

## Reproductions (deliverable 1)

Two committed repros. Both pass against the current code, which is the point: they
record the buggy cycle so the fix lane can flip their assertions.

1. Vitest, `src/0_terminalDiagrams.test.ts` description `diagram overlay flicker
   (diagnostic lane)`:
   - `hides the whole root on any write, before painting has decided anything`:
     constructs `TerminalDiagramOverlay` with DOM/term/projection stubs (the
     existing test file's deliberate node-env style) and asserts a single
     logically void `onWriteParsed` fires `root.hidden = true`. Run with
     `pnpm exec vitest run src/0_terminalDiagrams.test.ts`.
   - `re-creates the DOM element when a projected fence's buffer rows shift`:
     two fences with identical language, code, and `locator`, differing only in
     `start`/`end`, produce different `diagramElementKey` values.
2. Runnable e2e, `e2e/term-diagram-flicker.spec.ts`: boots `/e2e-term.html` with
   projection enabled, paints a fenced mermaid diagram, then streams `working N`
   writes while sampling `.term-diagrams` `hidden`, counting `childList`
   mutations on the root, and comparing the mermaid `data-diagram-key` before
   and after. Asserts the cycle is observed (at least one hidden root sample, or
   a re-keyed/re-placed element). Written steps are in the spec header. Runs with
   `pnpm test:e2e`.

## Root cause (deliverable 2)

### While typing and streaming: unconditional root hide

`term.onWriteParsed` at `src/0_terminalDiagrams.ts:416` runs on every parsed PTY
write. When a projection is present it does, at `:417`-`:423`:

```ts
this.root.hidden = true;        // :418
this.generation++;              // :419
this.positionElements();        // :420
if (!this.scrolling) this.recoveryEvents.next();   // :421
```

`recoveryEvents` is debounced 80 ms (`:403`-`:405`) before it calls
`scheduleFrame()`. `paint()` only clears the hide at `:574`
(`this.root.hidden = false`) after `Promise.all` of every async render resolves.
Streaming chat writes on every keystroke burst, so the root hides on each write
and unhides only after the 80 ms recovery window plus the render round trip. The
same unconditional hide fires on the wheel router's `viewportScrolled()`
(`:445`, wheel callback in `src/terminal.ts:741`), which the report attributes
the typing flicker to; the write-parsed path at `:418` is the higher-rate one.

The hide is not gated on anything. A write that changes nothing about the fence
set still hides and reveals the entire root. That is the typing flicker.

### While idle: rescan-driven element re-creation

The overlay's only idle trigger is the projection subscription at
`src/0_terminalDiagrams.ts:395`:

```ts
this.activitySubscription = projection.changes.subscribe(() => this.scheduleFrame());
```

`projection.changes` is `TerminalTurnVisibilityV2.updates`
(`src/0_terminalTurnVisibility.ts:381`). `scan()` re-locates the turn spans on
every scheduled pass and calls `updates.next` whenever `JSON.stringify` of a
turn differs from the prior pass, including `bufferStart` / `bufferEnd` /
`confidence` (`src/0_terminalTurnVisibility.ts:458`-`:463`). Rescans are driven
by a shared 1 s clock while the 5 s activity lease holds
(`src/0_terminalTurnVisibility.ts:351`-`:353`, `:415`-`:417`) plus the 120 ms
write debounce (`:408`-`:411`) and an immediate scroll pass (`:405`-`:407`).

`paint()` rebuilds each projected fence from `region.bufferStart` / `region.bufferEnd`
(`src/0_terminalDiagrams.ts:536`-`:537`). Element identity is:

```ts
export function diagramElementKey(fence: DiagramFence, dark: boolean): string {
  return `${dark}:${fence.language}:${fence.start}:${normalizedDiagramLines(fence.code).join("\n")}`;   // :254-256
}
```

`fence.start` is a physical buffer row. When a rescan moves the same logical
turn one row (re-anchor, a wrapped row, a status row dropped), the key changes,
`paint()` mints a fresh element (`:577`-`:579`), and `replaceChildren` at
`:620`-`:622` detaches and re-attaches, which flashes. The idempotent, stable
`locator` (`boop:${region.turnId}`, set at `:539`) is written to
`dataset.diagramLocator` at `:586` but never participates in the key.

The element key also includes the code, which changes while a streaming diagram
is still being typed; that re-keys the element on top of the row-shift path once
per rendered prefix. Idle, though, the code is stable and only the row moves, so
the row-in-key is the idle re-create cause.

### Who calls activate / syncEnabled / scheduleFrame, and on what cadence

| Caller | Site | Cadence | Effect |
| --- | --- | --- | --- |
| `projection.changes` | `src/0_terminalDiagrams.ts:395` | rescan loop, up to 1/s while leased | main idle driver; schedules a paint even when the rendered set is unchanged |
| `recoveryEvents` (80 ms debounce) | `:403` | after each write | restores root after a write hide |
| `scrollEvents` (80 ms debounce) | `:396` | after each wheel scroll | `viewportScrolled` path |
| `activate()` | `:454`, caller `src/terminal.ts:1116` | tab switch only | full hide + repaint; not an idle poll |
| `syncEnabled()` | `:461`, caller `src/chrome.ts:124` | inline-diagram button toggle only | full hide + repaint; not an idle poll |

`activate()` and `syncEnabled()` are not on any poll tick. The idle caller the
report feared is the `projection.changes` subscription at `:395`, fed by the
turn-visibility scan loop.

`positionElements()` at `:492` also hides individual elements whose rows left
the viewport (`:504`) until the next paint restores them; this is a secondary
per-element flash when rows shift during a rescan.

## Fix plan (deliverable 3)

Implement in this order. Each edit lists the guard it must carry; no judgment
calls remain.

### Edit 1: stabilize element identity (do first, everything else keys off it)

Change `diagramElementKey` at `src/0_terminalDiagrams.ts:254` so the physical
row is not part of the identity. Keep `fence.start` in the `dataset` for
positioning, only the key changes.

```ts
export function diagramElementKey(fence: DiagramFence, dark: boolean): string {
  const stable = fence.locator ?? `${fence.language}:${normalizedDiagramLines(fence.code).join("\n")}`;
  return `${dark}:${stable}`;
}
```

Guard conditions:

- `fence.locator` is already the turn-scoped `boop:${region.turnId}` for
  projected fences (`:539`) and is stable across rescan row shifts. Use it when
  present.
- Terminal-only explicit fences have no locator, so fall back to the
  code-normalized fingerprint. This keeps `findDiagramFences` results (pure
  buffer rows) re-usable across `mergeLocatedDiagrams` replacement by content,
  which is what the existing `uses one row-scoped DOM identity` test at
  `src/0_terminalDiagrams.test.ts:305` asserts. That test keeps passing.
- Re-run the vitest case added in this lane; the fix flips its assertion to
  expect the two shifted-row keys to be equal. Update the assertion, do not
  delete the case.

### Edit 2: guard the root hide on write/scroll

At `src/0_terminalDiagrams.ts:418` (write-parsed) and `:445` (`viewportScrolled`),
only hide when the rendered fence set or viewport changed. Compare a cheap
fingerprint of the current fence keys plus the viewport before hiding:

```ts
private fenceFingerprint(): string {
  const top = this.term.buffer.active.viewportY;
  const end = top + this.term.rows - 1;
  const keys = this.projection?.visible
    .flatMap((turn) => turn.regions)
    .filter((r) => r.kind === "mermaid" || r.kind === "d2")
    .filter((r) => r.bufferEnd >= top && r.bufferStart <= end)
    .map((r) => diagramElementKey(this.fenceFor(r), darkBackground(this.host)))
    .sort()
    .join("|") ?? "";
  return `${this.generation}:${top}:${keys}`;
}
```

Store `lastVisibleFingerprint`. In the write handler and `viewportScrolled`,
compute it; only when it changed from the previous value do:
`this.root.hidden = true; this.generation++; this.positionElements();`
and only then emit `recoveryEvents`/`scrollEvents`.

Guard conditions:

- A write or scroll that leaves the visible fence keys and viewport identical
  must not touch `root.hidden` at all. `root.hidden` stays `false`; the diagram
  never blinks.
- `generation` must not advance on a no-change event, else the stale-paint check
  at `:573` (`generation !== this.generation`) will still discard an in-flight
  paint and force the hide.
- When it does change, keep the existing hide-then-paint behavior so the new
  rows settle before the reveal. Do not remove the hide; only gate it.

### Edit 3: debounce/coalesce the hide with the paint (typing burst)

A single keystroke burst is several writes in a few ms. Instead of flipping
`root.hidden` synchronously per write, defer the hide to the recovery window
already used to coalesce: set a `hideRequested = true` flag in the handler, and
have `scheduleFrame` (or the 80 ms recovery subscriber) apply `root.hidden =
true` exactly once before `paint()` runs. `paint()` then clears it at `:574`.

Guard conditions:

- Within one burst the root hides at most once, not once per write.
- `hideRequested` is cleared by `paint()` when it clears `root.hidden`.
- This is a refinement over Edit 2, not a replacement; keep Edit 2's guard so a
  no-op write does not even set `hideRequested`.

### Edit 4: skip no-op repaints from idle rescans

In `paint()` after recomputing `visibleFences` at `:548`-`:550`, if every
`diagramElementKey` equals the keys of the currently mounted elements and the
viewport is unchanged, return before the `Promise.all` render at `:551`.
Reuse the fingerprint from Edit 2.

Guard conditions:

- Do not skip when dark mode, viewport, or any fence key changed; those still
  repaint.
- The skip must not advance `generation`, so a later real change still wins the
  stale check.

### Not fixing here (out of scope, noted for the implementer)

- `positionElements()` still hides fully-exited rows at `:504`; that is correct
  and stays. Edit 4 removes the idle repaint that previously raced it.
- The render cache (`:552`-`:557`) already keys on code only, so stabilized
  elements reuse rendered SVGs on row shifts without a re-render.

## Validation for the implementer

```bash
just check          # tsc --noEmit across src
just test           # vitest run, includes the two repro cases
pnpm test:e2e       # flips the e2e repro to expect no hide and stable keys
```

`just build` and `just cargo-check` are untouched by these edits but remain
gates; run them before commit.

## Row of the bug, end to end

```mermaid
flowchart LR
    W[PTY write] --> OP[onWriteParsed :416] --> H[hide root :418] --> R[recovery 80ms :403]
    S[wheel] --> VS[viewportScrolled :445] --> H2[hide root :445]
    C1[turn scan 1/s :415] --> CH[changes fires] --> SUB[projection.changes :395]
    SUB --> FR[scheduleFrame :470] --> P[paint :515]
    C2[bufferStart drift] --> K[diagramElementKey :254 uses row] --> RE[element re-mint :579] --> RR[re-placeChildren :621]
    H --> RE
    subgraph FIX[guard targets]
      H2
      CH
      K
    end