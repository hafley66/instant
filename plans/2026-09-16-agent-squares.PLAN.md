# Agent squares: the right-margin turn strip

Date: 2026-09-16. Status: plan only. No implementation is committed on this
branch; four modules are drafted in the worktree and are listed at the end.

## Goal

A 32px right margin inside the terminal panel, holding one square per turn on
screen: user, assistant and tool turns, coloured and sized by role, with the
active square (the one being read) scaled, every square hoverable for a popover,
and favorites and tags visible on the squares that carry them.

Constraints that decide the design:

- **Popovers never wait.** Hover is CSS on a pre-rendered child. No handler, no
  state write, no read on hover, so the popover appears in the frame the pointer
  arrives.
- **Nothing per frame.** Every read is keyed to a change: the visible-turn set,
  the favorite set, the visible id list. No interval polls a pane, a db or IPC.
- **The terminal owns the geometry.** The pane reflows into the narrower area
  through xterm's own `fit()`, so the grid and the strip cannot disagree.

## Where the data already is

| need | source | cost |
|---|---|---|
| turns on screen | `TerminalTurnVisibilityV2.changes` / `.visible` per tab | already computed on activity |
| which one is being read | `term.buffer.active.viewportY` on `term.onScroll` | one xterm read |
| turn identity colour | `turnHue(id)` (`0_turnDebugOverlay.ts`) | pure |
| favorites | `boop_favorites()` → `boopFavorites` cache in `favorites.ts` | one read, refreshed on enable/toggle |
| tags | `Store::tags_for_many(&[id])` over the visible id set | one read per visible-set change |

Nothing here needs the boop-side `lane squares` verb. The pane text, the matcher
and the projection are already running for the turn-debug overlay; the strip is a
second projection of the same stream. If instant later wants the boop-side
matcher instead, `boop_mux_capture` + `boop_turns` + `boop_locate_turns` are the
existing three calls, and `boop beep lane squares <lane>` (hafley-rs
`feat/terminal-snapshot-squares`, commits `727c4239`, `67df7fe4`) is the same
projection in one call for a debug path.

## Type chain

```
TerminalTurnVisibilityV2.changes        term.buffer.active.viewportY
        │ events.visible : VisibleTurn[]        │ focusRow
        └──────────────┬─────────────────────────┘
                       ▼
   [model]  squaresOf(visible, focusRow, max) → { squares: AgentSquare[], active: number }
                       │ AgentSquare = { id, kind, role, turn, hue, at, preview }  pure data
                       ▼
   [visual] createSquareVisual(seed) → SquareVisual   stable per id, held in a ref map
                       │ SquareState = SquareSeed & { active, y, strength }
                       │ written only by placeSquare / activateSquare / reseedSquare
                       ▼
   [view]   AgentSquaresView({ visuals, marks })      pure, reads .$() only
                       ▼
            .asq{--asq-y,--asq-scale,--asq-color}  +  .asq-pop (CSS hover)
```

## Props and input/output

```ts
type SquareVisual = Signal<SquareState>        // SignalCreator tree
type SquareState  = SquareSeed & { active: boolean; y: number; strength: number }
type SquareSeed   = { id; kind: "user" | "agent" | "tool" | "other";
                      role: string; turn: number; hue: number;
                      at: string; preview: string }
type TurnMark     = { favorite: boolean; tags: string[] }
type SquareMarks  = Record<string, TurnMark>   // keyed by turn id, `session:turn`

type AgentSquaresViewProps = {
  visuals: SquareVisual[]   // handle per square, oldest first
  marks: SquareMarks
}
```

| boundary | in | out | pure |
|---|---|---|---|
| `squaresOf` | `VisibleTurn[]`, `focusRow`, `max` | `AgentSquare[]` + active index | ✓ |
| `createSquareVisual` | `SquareSeed` | `SquareVisual` | ✓ |
| `placeSquare` / `activateSquare` / `reseedSquare` | `SquareVisual`, scalars | — | one field each |
| `strengthAt` / `squareColor` / `squareVars` | state or scalars | number / css / custom props | ✓ |
| `AgentSquaresView` | `visuals`, `marks` | DOM | ✓ no effects, no handlers |
| `AgentSquares` | `{ term, visibility }` | `<AgentSquaresView/>` | owns subscriptions |
| `useSquareVisuals` | `AgentSquare[]` | `SquareVisual[]` | ref map keyed by id |

React holds **handles, not state**: the hook creates a visual on first sight,
calls `place`/`activate`/`reseed` on every render, and drops ids that left the
projection. The view only reads `.$()`, which the vite `signalsJsx()` plugin
tracks — no `SignalReact`, no `useSignal` in the strip.

## Behaviour

| axis | rule |
|---|---|
| count | `agentSquares.max` (default 24), newest end kept; older turns drop off the top |
| height | uniform: every square is `SQUARE_H`; the strip is capped at `SQUARE_STRIP_MAX` and the window slides inside it. Turn size never changes a square's height |
| scale | flexed by the turn's share of the window, `clamp(RATIO_FLEX · L_t / L_ref, SQUARE_MIN, SQUARE_MAX)`; the active square's `SQUARE_SCALE` (1.55) multiplies on top and the clamp applies last |
| placement | `y` comes from estimated cumulative rows, never from index: a 50-line result takes more strip than a one-line prompt, bounded by the clamp |
| viewport | the on-screen block is the viewport range pushed through the same cumulative map, clamped to a minimum height so it never vanishes |
| active | the square whose `[bufferStart, bufferEnd]` contains `viewportY`; above the first kept square → the oldest kept; past the last → the newest |
| click | nothing is bound. A square carries no handler and writes no state; the only affordances are the CSS `:hover` / `:focus-visible` popover and the browser tooltip |
| strength | 1 at the active square and its neighbours, `SQUARE_DIM` past them |
| motion | `y` and `scale` are custom props on a transitioned `transform`; reorders and re-scales animate without layout |
| entry | CSS `asq-in` keyframe, run once per element by a stable `key` |
| gutter | `SQUARE_GUTTER` 32px `padding-right` on the terminal element, then `tab.fit.fit()` |
| popover | `.asq-pop` child, 360px, role · turn · time header + preview, CSS `:hover`/`:focus-visible` — pointer arrives, frame shows it, no read runs |
| marks | star for a favorite, tick for tags; both also listed in the popover |

## Estimator: rows for a turn nobody can see

instant does not own the pane's rendering, so the strip cannot read geometry for
every turn. It measures what is on screen and extrapolates the rest.

Per update, from the matcher and xterm:

| symbol | meaning |
|---|---|
| `V` | turns with at least one row inside the viewport |
| `s_i, e_i` | the buffer rows that turn `i ∈ V` occupies on screen |
| `l_i` | lines of turn `i` inside the viewport |
| `L_t` | the turn's own total line count in the rolling window (projection, exact) |
| `r_t = l_t / L_t` | the fraction of the turn the reader can see, `0 < r ≤ 1` |
| `g_i = max(0, s_{i+1} − e_i − 1)` | viewport rows between two adjacent attributed turns: blank, separator, or unattributed |

```text
rows-per-line, per kind:  kappa_k = Σ_{i∈V, kind k} (e_i − s_i + 1) / r_i
                                     ────────────────────────────────────
                                              Σ_{i∈V, kind k} L_i

gap overhead, per kind:   gamma_k = mean of g_i over boundaries whose newer turn is kind k

cold fallback:            kappa = 1, gamma = 0

est_rows(t) = clamp(kappa_kind(t) · L_t, L_t, kappa_max · L_t)
              kappa_max = max(1, max over V of kappa_k)   ← measured, not theoretical

row_est(t) = row_est(anchor) ± Σ_{u between} ( est_rows(u) + gamma_kind(u) )
             +    ← older than the anchor, − newer

monotone repair: row_est(t_{i+1}) = max(row_est(t_{i+1}), row_est(t_i) + 1)
```

Three tiers of trust, strongest first: a turn with any rows on screen keeps its
measured span; a partly visible turn (`0 < r < 1`) estimates its own full size as
`(e − s + 1) / r` and calibrates `kappa_kind`; a turn with no rows on screen uses
`kappa_kind · L_t`; with no samples at all, `kappa = 1`.

Worked case — the agent asks "what is 50 lines above the SQL result?" with
`kappa_prose = 1.15`, `gamma_tool = 1.8`, one boundary between them:

```text
Delta rows = 1.15 × 50 + 1.8 = 59.3  →  ~59 buffer rows
```

Strip mapping, over the whole window:

```text
S        = Σ_{t ∈ window} est_rows(t)
y(t)     = (Σ_{t' older than t} est_rows(t')) / S · (SQUARE_STRIP_MAX − SQUARE_H)
onScreen = [ Σ_{t' older than vpStart} est_rows(t') / S , Σ_{t' ≤ vpEnd} est_rows(t') / S ]
```

Percent-of-turn seen (`r_t`) drives the partial-visibility case above; the
estimator never overrides a measured span, it only fills the rows nobody
attributed.

## Reads and their keys

```ts
// the squares themselves: already-computed stream, wrapped into a signal
const events = Signal(visibility.changes, { visible: visibility.visible, entered: [], exited: [] })

// scroll: xterm's own signal drives placement, no polling, no read
const focus = Signal<number | null>(term.buffer.active.viewportY)
term.onScroll(() => focus.$(term.buffer.active.viewportY))
// the visible set is re-derived from focus + the row estimator on scroll, so a
// stream that never goes quiet still updates the block

// favorites: one read, cached by favorites.ts, refreshed on enable and toggle
boopFavorites                       // matched by `turn:${session}:${turn}`

// tags: one call for the whole visible set, through a `boop_tags_for_many`
// command to add beside `boop_tags_for` (it wraps boop-store's tags_for_many).
// throttle, not debounce: a streaming pane never goes quiet, so a debounce
// would starve the read. Leading edge paints immediately, trailing edge
// coalesces the burst that landed during the window.
visibleIds$.pipe(
  throttleTime(TAG_THROTTLE_MS, undefined, { leading: true, trailing: true }),
  distinctUntilChanged(),           // sorted joined ids
  switchMap(ids => invoke("boop_tags_for_many", { sources: ids })),   // Record<id, string[]>
)
```

Rules the plumbing has to keep:

1. **Invalidate by change, never by timer.** A quiet pane reads nothing; a busy
   pane reads at most once per throttle window. Never debounce a stream that
   never goes quiet.
2. **One reconciliation in flight.** `switchMap` (a superseded tag read is
   worthless), not `mergeMap`.
3. **Emit only when the projection differs.** `distinctUntilChanged` on the
   visible id list and on the derived square list.
4. **Measure before estimate.** A row span the matcher attributed is never
   replaced by a computed row.

## Files

| file | role | state |
|---|---|---|
| `src/0_agentSquaresSettings.ts` | `agentSquares = { on, max }` | drafted |
| `src/0_agentSquareVisual.ts` | geometry, colour, anims, `SignalCreator` state | drafted |
| `src/1_agentSquaresModel.ts` | `squaresOf` and the pure helpers | drafted |
| `src/1_agentSquaresEstimate.ts` | `kappa_k` / `gamma_k` / `est_rows` / monotone `row_est`, `y(t)`, the on-screen block | to write |
| `src/1_agentSquares.css` | strip, transitions, CSS-only popover | drafted |
| `src/1_agentSquaresMarks.ts` | favorites + tags per turn id | to write |
| `src/1_agentSquares.tsx` | `useSquareVisuals`, `AgentSquaresView`, container, mount | to write |
| `index.html` | `#squares-toggle` beside the other four | to edit |
| `src/chrome.ts` | `bindAgentSquaresChrome()` — button state + `syncAgentSquares()` | to edit |
| `src/main.ts` | call the bind beside `bindTurnDebugChrome()` | to edit |
| `src/terminal.ts` | `applyAgentSquares(tab)` / `syncAgentSquares()`; `Tab.agentSquares`; dispose paths; call in `activate()` | to edit |

Drafted modules are uncommitted working-tree files in
`.boop-worktrees/feat/agent-squares`; nothing is staged.

## Verification

- `pnpm typecheck`, `pnpm test` (vitest) in the worktree.
- Unit: `squaresOf` against a fixture `VisibleTurn[]` — cap keeps the newest end,
  the active pick follows `focusRow` across the three cases, roles map to kinds.
- Unit: `squareVars` / `strengthAt` / `squareColor` are pure outputs.
- Unit: the estimator on a fixture with one fully visible turn, one half visible
  (`r = 0.5`), and one off screen — `kappa_k` recovers the fixture's true
  rows-per-line, `est_rows` stays inside `[L_t, kappa_max · L_t]`, and
  `row_est` never inverts on a shuffled window.
- Unit: `y(t)` and the on-screen block are monotone in `row_est` and the block
  keeps its minimum height at both ends of the window.
- Browser: enable the toggle, open a busy claude tab, confirm the gutter is 32px,
  the pane reflows, the active square scales, and a popover shows without a
  frame's delay while a turn streams.
- Perf check: with the strip on and a pane producing output, the strip issues no
  reads of its own; the tag read fires once per visible-set change.

## Decided

1. **One batch read, never n+1.** Settled, not a question. hafley-rs
   `910dc8c5` (`main` `943f8fd0`) adds `Store::tags_for_many(&[String])` in
   `crates/boop-store/src/tags.rs` — one `IN` statement over `agent_tag_link`,
   every source asked for present, an untagged source answering `[]` — and
   `boop tag for <SOURCE>... [--format text|json]` in `crates/boop/src/cli/tag.rs`
   for the shell. instant links `boop-store`, so the marks file adds a
   `boop_tags_for_many(sources)` command beside `boop_tags_for` (same
   `0_boop.rs` / `lib.rs` / `serve/rpc.rs` registration) and reads the whole
   visible set in one call. No per-square tag read exists in either path.
   `boop_tags_for` stays only for the single-source case `favorites.ts` already
   uses.
2. **Throttle, not debounce.** The visible-id read is
   `throttleTime(TAG_THROTTLE_MS, undefined, { leading: true, trailing: true })`.
   A streaming pane never goes quiet, so a debounce would starve the read;
   leading edge paints now, trailing edge coalesces the burst.
3. **Visibility comes from scroll plus estimates.** instant does not own the
   pane's rendering, so the on-screen set and the strip's block are re-derived
   from `viewportY` through the row estimator on every scroll event. Placement
   never polls and never issues a read.
4. **Interaction is hover only.** A click binds nothing and writes nothing; the
   popover and the tooltip are CSS on a pre-rendered child, so the pointer
   arrives in the same frame as the paint.
5. **Uniform squares, clamped flex.** One `SQUARE_H`, one
   `SQUARE_STRIP_MAX`; the scale flexes by estimated size inside
   `[SQUARE_MIN, SQUARE_MAX]`.

## Open

1. **Exit animation.** Entry is a CSS keyframe; a square that leaves the
   projection disappears on the same frame. An exit animation needs a
   short-lived presence list.
2. **Estimator constants.** `RATIO_FLEX`, `SQUARE_MIN`, `SQUARE_MAX`, the
   per-kind bucket list, and `TAG_THROTTLE_MS` need measurements from a busy
   pane before they are pinned.
