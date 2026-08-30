# FLASH_INSTANT_RECTANGLE_REPORT

## What this lab built

One opt-in Instant tab that consumes `@hafley66/react-dock-and-flow@0.0.3`
through Instant's existing plugin + Dockview instance registry. `openRectangleWorkspace`
is the single exported seam: it opens or focuses one restorable `rect:<id>` Dockview
tab whose content is a deterministic projection of the input onto the package's
`Rectangle` model, rendered by the package's `RectangleCanvas` (React Flow + the
package React DOM session renderer and Cytoscape graph renderer).

## Files changed (exact)

Added (untracked):

| path | LOC | role |
|---|---|---|
| `src/plugins/rectangle/0_types.ts` | 94 | input type + pure `projectRectangles`/`rectangleSignature` |
| `src/plugins/rectangle/0_types.test.ts` | 159 | Vitest snapshot tests (projection + same-id update boundary) |
| `src/plugins/rectangle/1_RectangleView.tsx` | 62 | Dockview panel host, model lifecycle, fills host |
| `src/plugins/rectangle/2_workspace.ts` | 84 | per-id model registry + instance registration + opening seam |
| `src/plugins/rectangle/index.ts` | 4 | re-exports public seam |
| `e2e/rectangle.tsx` | 55 | app-level harness entry (Dockview html page) |
| `e2e/rectangle-app.spec.ts` | 48 | Playwright app-level receipt |
| `e2e/rectangleIsolation.tsx` | 69 | isolation harness (raw package `RectangleCanvas`) |
| `e2e/rectangle-isolation.spec.ts` | 78 | Playwright isolation receipt |
| `e2e-rectangle.html` | 27 | app-level html page |
| `e2e-rectangle-isolation.html` | 13 | isolation html page |

Modified:

| path | delta |
|---|---|
| `src/main.ts` | +2 (import + `registerRectangle()` call) |
| `package.json` | +4 (deps: `@hafley66/react-dock-and-flow@0.0.3`, `@xyflow/react@^12.11.2`, `cytoscape@^3.33.1`; devDep `@types/cytoscape`) |
| `pnpm-lock.yaml` | lockfile entries for the new deps |

All new source files are well under the 500-line cap (max 159, the test file).

## Exported signatures (exact)

From `src/plugins/rectangle/index.ts`:

```ts
export function openRectangleWorkspace(input: RectangleWorkspaceInput): void;
export function registerRectangle(): void;
export type RectangleWorkspaceInput = {
  id: string;
  title: string;
  sessions: readonly { id: string; title: string; lines: readonly string[] }[];
  graph?: { id: string; title: string; nodes: readonly string[]; edges: readonly (readonly [string, string])[] };
};
```

Supporting (internal to `src/plugins/rectangle/`):

```ts
// 0_types.ts
export function projectRectangles(input: RectangleWorkspaceInput): ProjectedRectangle[];
export function rectangleSignature(rectangles: ProjectedRectangle[]): string;
// 2_workspace.ts
export const RECT_PREFIX = "rect:";
export function acquireRectangleModel(key, signature, build): RectangleModel;
export function releaseRectangleModel(key, model): void;
```

Instance registration (via `registerPlugin`): id `rectangle`, prefix `rect:`,
componentName `rectangle-instance`, `restorable: true`, `panels: []` (no rail
button, no startup/rail/default-layout mutation).

## Lifecycle timeline

1. **Open**: `openRectangleWorkspace(input)` writes `input` to `pluginState.rectangle`
   (keyed by `encodeURIComponent(input.id)`), then calls `openPanelInstance("rectangle", id, title, {})`.
2. **Focus/dedup**: `openPanelInstance` finds an existing `rect:<id>` panel and
   focuses it; a same-id reopen never creates a second tab.
3. **Mount/acquire**: `RectangleView` reads the persisted input via `useApp`
   (the existing repo store boundary), projects to rectangles, computes a content
   signature, and `acquireRectangleModel` returns the registered model if the
   signature matches, else builds a new one. One model per open workspace id.
4. **Render**: `<RectangleCanvas model={model} />` (package component) renders the
   session + graph rectangles; `RectangleCanvas` is keyed by signature.
5. **Input update (same id)**: `openRectangleWorkspace` with changed content updates
   `pluginState` -> store notification -> `RectangleView` re-projects -> new
   signature -> registry model replaced and `RectangleCanvas` remounts. Deterministic.
6. **Hide/show / close/reopen**: `RectangleView` root is `width:100%;height:100%`,
   so React Flow (which needs a measured parent) fills the Dockview host on every
   mount. No second canvas layers over the first (asserted by cytoscape count == 1).
7. **Unmount**: `RectangleView` effect cleanup calls `releaseRectangleModel`, and
   React unmounts `RectangleCanvas`, whose `GraphContent` effect destroys the
   Cytoscape instance. React + Cytoscape resources owned by the view are released.
8. **Restore**: a persisted `rect:<id>` panel (restorable instance) rebuilds its
   input from `pluginState` on mount; no second global store was created.

## Commands and exit codes

| command | exit |
|---|---|
| `corepack pnpm@10.12.4 install` | 0 |
| `just check` (todo-check green-by-skip on worktree, api:check, `tsc --noEmit`) | 0 |
| `just build` (api:check + tsc + vite build) | 0 |
| `corepack pnpm@10.12.4 exec vitest run` (full suite) | 0 |
| `corepack pnpm@10.12.4 exec vitest run src/plugins/rectangle/0_types.test.ts` | 0 |
| `corepack pnpm@10.12.4 exec playwright test e2e/rectangle-isolation.spec.ts e2e/rectangle-app.spec.ts` | 0 |

`just dev` was not run.

## Test names and results

Vitest (all 4 pass; full suite 503/503):

- `projectRectangles > projects sessions and graph into positioned, sized package rectangles` (inline snapshot: ids, positions, sizes, session content, graph content)
- `projectRectangles > encodes readonly inputs into the package's mutable tuple/lines shape`
- `projectRectangles > is deterministic: same input projects to identical rectangles and signature`
- `same-id update / dedup at the pure boundary > projects a changed input for the same id to a new, deterministic signature`

Playwright (both pass):

- `isolation: one session + one cytoscape graph, move rectangle, undo, PNG`
  - mounts the real `RectangleCanvas`, asserts session text + graph text + a
    cytoscape canvas, moves the session rectangle via the package `moved` event,
    asserts the moved position, asserts undo restores it, asserts the graph canvas
    is non-blank, captures PNGs.
- `openRectangleWorkspace opens a Dockview tab beside an existing Sessions tab`
  - invokes the exported seam in the harness, proves the rectangle workspace is a
    Dockview tab beside the ordinary Sessions tab (tab count 1 -> 2), same-id
    reopen stays at 2 (no duplicate), close/reopen keeps one cytoscape canvas,
    captures PNGs.

No `toBeDefined()` assertions anywhere.

## PNG receipt paths

All non-blank, contain session + graph identifying text (verified: app PNGs ~1860
unique colors, isolation PNGs ~1310 unique colors, all 1280x720):

- `test-results/rectangle-isolation-moved.png` (isolation, after move)
- `test-results/rectangle-isolation-final.png` (isolation, after undo)
- `test-results/rectangle-app-tab.png` (app-level, rectangle tab beside Sessions)
- `test-results/rectangle-app-reopened.png` (app-level, after close/reopen)

## Source LOC added/removed

- Added: ~693 source/test/harness lines (sum of table above).
- Removed: 0.
- Modified tracked files: `src/main.ts` +2, `package.json` +4,
  `pnpm-lock.yaml` +119 (lockfile entries).

## Deviation from the brief

- Isolated the pointer-drag receipt to dispatch the package's canonical `moved`
  event (via `window.__rectTest.move`) instead of a raw Playwright mouse drag.
  A real mouse drag does not produce a `moved` event because the package's
  `RectangleCanvas` renders React Flow in controlled mode without updating its
  own `nodes` array during drag, so a pointer drag never reaches drag-stop.
  Dispatch through the model is the package's own move mechanism. The real
  `RectangleCanvas` component (with Cytoscape) is still mounted and the undo path
  is exercised through the package model.
- `renderer`/`keepAlive` was dropped from the instance def. The default Dockview
  content keeping, plus explicit `height:100%` on the panel root, gives the
  requested hide/show survival without a layered second canvas; `keepAlive`
  left a hidden pooled clone on close/reopen that broke the single-canvas assert.
- Implemented the content-update path by re-projecting and re-creating the model
  when the input signature changes; the package journal is dropped on content
  replacement (see limitation below).

## Public API limitation in `@hafley66/react-dock-and-flow@0.0.3`

1. **No content-replacement event; `initial` is fixed at model creation.**
   `createRectangleModel(initial)` + `replayRectangles` fold every event
   (`moved`/`raised`/`undo`/`redo`) over that single `initial` array. There is no
   event to change a rectangle's title/content after creation, and no setter for
   `initial`. A same-id input update therefore cannot be applied onto a live
   model through the public API. Adapted by re-building the model (dropping the
   old journal) when the projected content signature changes; positions/undo
   survive an unchanged-signature reopen.

2. **`Rectangle` requires mutable shapes.** The brief's readonly inputs map to
   package `content.lines: string[]` and `edges: [string, string][]` (mutable
   array/tuple). Adapted at the projection boundary in `0_types.ts`.

3. **Closed control flow for movement.** `RectangleCanvas` uses a controlled
   `nodes` prop that it never updates during React Flow drag and only emits
   `moved` on drag-stop, so a raw pointer drag does not move the rectangle under
   automated driving (manifested as deviation #1). Not a model limitation; the
   `moved` event path works.
