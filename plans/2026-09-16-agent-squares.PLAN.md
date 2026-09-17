# Agent squares: the right-margin turn strip

Date: 2026-09-16. Status: landed on `feat/agent-squares`. The crate, the app
modules and the live tier are committed; the files table and the open items
below are the ones that survived implementation.

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
| turns on screen | the server's own capture + `boop-turnvis` (`1_squares.rs`) | one capture per write burst, 120 ms coalesced |
| which one is being read | `#{pane_height}` + `#{scroll_position}` read off the pane | one `display-message` per projection |
| where each square sits | `boop-turnstrip::layout` over those rows | pure, in Rust |
| turn identity colour | `turnHue(id)` (`0_turnDebugOverlay.ts`) | pure, client |
| favorites | `boop_favorites()` → `boopFavorites` cache in `favorites.ts` | one read, refreshed on enable/toggle |
| tags | `tags_for_many` inside the feed (`1_squares.rs`) | one read per projection, riding the frame |

Nothing here needs the boop-side `lane squares` verb. If instant later wants a
debug path, `boop_mux_capture` + `boop_turns` + `boop_locate_turns` are the
existing three calls, and `boop beep lane squares <lane>` (hafley-rs
`feat/terminal-snapshot-squares`, commits `727c4239`, `67df7fe4`) is the same
projection in one call.

The client's own matcher (`TerminalTurnVisibilityV2`) is not touched by any of
this. The terminal's other overlays read `regions[]` — diagrams, the context
gutter, structured rows — and `boop-turnvis` does not produce regions, so the
local matcher keeps its own path. The strip is a second projection of the same
stream, computed where the pane and the store already are.

## Type chain

```
pane capture + turns + tags                  server: src-tauri/src/1_squares.rs
        │ boop-turnvis: spans + ids           │ #{pane_height}, #{scroll_position}
        └──────────────┬──────────────────────┘
                       ▼
   [crate]  boop-turnstrip::layout → Layout
                       │ Layout = { squares: [{ id, kind, y, scale, active }], span, block }
                       │ rows_of: how much of each turn the window holds
                       ▼
   host.emit("squares-update", Strip)          one frame; the client sends nothing
        │ nativeEvent$ → squaresFeed(session)
        ▼
   [model]  squaresOf(frame) → { squares: AgentSquare[], active: number }
                       │ AgentSquare = { id, kind, role, turn, hue, at, preview, y, scale, active }
                       ▼
   [visual] createSquareVisual(seed) → SquareVisual   one per square, held by id
                       │ SquareState = SquareSeed & { active, y, scale, strength }
                       │ written only by placeSquare / activateSquare / reseedSquare
                       ▼
   [view]   TerminalAgentSquares                      one node per square, kept across frames
                       │ subscribes its own visual and writes nothing else
                       ▼
            .asq{--asq-y,--asq-scale,--asq-color}  +  .asq-pop (CSS hover)
```

## Props and input/output

```ts
// on the wire (src/1_agentSquaresFeed.ts), one frame per projection
type StripTurn   = { id; session; harness; turn; ts; role; said; bufferStart; bufferEnd; ... }
type StripLayout = { squares: { id; kind; y; scale; active }[]; span: number; block: { top; height } }
type Strip       = { session; at; rows; turns: StripTurn[]; tags: Record<string, string[]>; layout: StripLayout | null }

type SquareVisual = Signal<SquareState>        // SignalCreator tree
type SquareState  = SquareSeed & { active: boolean; y: number; strength: number }
type SquareSeed   = { id; kind: "user" | "agent" | "tool" | "other";   // kind comes off the frame
                      role: string; turn: number; hue: number;
                      at: string; preview: string; y: number; scale: number }
type TurnMark     = { favorite: boolean; tags: string[] }
type SquareMarks  = Record<string, TurnMark>   // keyed by turn id, `session:turn`

type AgentSquaresViewProps = {
  visuals: SquareVisual[]   // handle per square, oldest first
  marks: SquareMarks
}
```

| boundary | in | out | pure |
|---|---|---|---|
| `squaresOf` | `Strip` (the pushed frame) | `AgentSquare[]` + active index | ✓ |
| `createSquareVisual` | `SquareSeed` | `SquareVisual` | ✓ |
| `placeSquare` / `activateSquare` / `reseedSquare` | `SquareVisual`, scalars | — | one field each |
| `strengthAt` / `squareColor` / `squareVars` | state or scalars | number / css / custom props | ✓ |
| `TerminalAgentSquares.render` | `Strip` (the frame) | DOM | ✓ no reads, no timers |
| `TerminalAgentSquares.start` / `dispose` | `{ pty, session, target }` | a watcher, and its teardown | owns one subscription |

`y` and `scale` are the server's numbers and are forwarded, not re-derived: a
square's height is a function of the whole window (`span`), so a client that
recomputed it from one turn would disagree with every other square.

The strip holds **handles, not state**: a frame creates a visual only for a
square it has not seen, calls `place` / `activate` / `reseed` on the rest, and
drops the ones that left. Each element subscribes its own visual and writes its
own CSS variables, so one square moving never touches another's node — and the
CSS owns the interpolation from there.

## Behaviour

| axis | rule |
|---|---|
| count | `boop-turnstrip`'s `Options::max_squares` (24), newest end kept; older turns drop off the top. The cap is the server's because it changes `span` and therefore every `y` |
| height | uniform: every square is `SQUARE_H`; the strip is capped at `SQUARE_STRIP_MAX` and the window slides inside it. Turn size never changes a square's height |
| scale | flexed by the turn's total against the window's median, `clamp(1 + RATIO_FLEX · (L_t / L_ref − 1), SQUARE_MIN, SQUARE_MAX)`; the active square's `SQUARE_SCALE` (1.55) multiplies on top and the clamp applies last. Computed in the crate, forwarded as `scale` |
| placement | `y` comes from estimated cumulative rows, never from index: a 50-line result takes more strip than a one-line prompt, bounded by the clamp. Computed in the crate, forwarded as `y` |
| viewport | the on-screen block is the window pushed through the same cumulative map, clamped to a minimum height so it never vanishes. Computed in the crate, forwarded as `block` |
| active | the square holding the window's first row (the reader's top row); above the first kept square → the oldest kept; past the last → the newest. Computed in the crate, forwarded as `active` |
| click | nothing is bound. A square carries no handler and writes no state; the only affordances are the CSS `:hover` / `:focus-visible` popover and the browser tooltip |
| strength | 1 at the active square and its neighbours, `SQUARE_DIM` past them |
| motion | `y` and `scale` are custom props on a transitioned `transform`; reorders and re-scales animate without layout |
| entry | CSS `asq-in` keyframe, run once per element by a stable `key` |
| gutter | `SQUARE_GUTTER` 32px `padding-right` on the terminal element, then `tab.fit.fit()` |
| popover | `.asq-pop` child, 360px, role · turn · time header + preview, CSS `:hover`/`:focus-visible` — pointer arrives, frame shows it, no read runs |
| marks | star for a favorite, tick for tags; both also listed in the popover |

## Estimator: rows for a turn nobody can see

The estimator lives in `boop-turnstrip` (hafley-rs `crates/boop-turnstrip`), not
in the client. It is a pure function of the pane's rows, the turns the matcher
found on them, and the window those rows are seen through, so it runs wherever
the rows already are — the feed thread, which is the only place that has them
without a fetch.

The window is not a client fact either. Scrolling a pane parks it in tmux
copy-mode (`pty::scroll_session`), so a client's view is the capture's tail
shifted up by `#{scroll_position}` inside `#{pane_height}` rows:

```text
window = [ rows − pane_height − scroll , rows − 1 − scroll ]     in capture rows
focus  = window.top                                              the reader's top row
```

Measured on tmux 3.7b: `capture-pane -p -J -S -400` returns the live area at its
tail whatever the copy-mode offset is (a pane scrolled 20 rows still captured
`199, 200` last), and `scroll_position` is empty outside copy-mode. `-S -400` is
what makes `rows` large enough to hold a window of turns; only the tail matters.

Per update, from the matcher and the window:

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
attributed. `l_i` (the lines of a turn inside the window) comes from
`boop-turnstrip::rows_of`, which aligns the turn's own `said` lines against the
window's rows (`align_rows`). That is the Rust successor to the client's
`regions[].sourceBufferRows`: the same fact, computed where the rows are, and it
is why no region projection has to cross the wire.

## Reads and their keys

Server side, one projection per write burst (`1_squares.rs`):

```text
pty write          ->  one dirty bit (capacity-1 channel)     no read
FLUSH_INTERVAL     ->  capture-pane -p -J -S -400             one tmux call
                      display-message '#{pane_height}|#{scroll_position}'
                      boop-turnvis::locate_visible_turns      pure
                      boop-turnstrip::layout                  pure
open_store_ro()    ->  tags_for_many(sources of the turns)    one statement
                      host.emit("squares-update", Strip)      push
```

Client side, no reads at all:

```ts
// the strip is a subscription; the frame is the whole input
squaresFeed(session)                 // nativeEvent$("squares-update") | filter(session)
squaresOf(frame)                     // pure: hue, header, preview; y/scale/active forwarded

// favorites: one read, cached by favorites.ts, refreshed on enable and toggle
boopFavorites                        // matched by `turn:${session}:${turn}`
```

Rules the plumbing keeps:

1. **Invalidate by change, never by timer.** A quiet pane projects nothing; a
   busy pane projects at most once per `FLUSH_INTERVAL`. Nothing polls.
2. **One reconcile in flight.** The feed thread coalesces the burst that landed
   during a flush into the next projection rather than queueing one per write.
3. **Measure before estimate.** A row span the matcher attributed is never
   replaced by a computed row.
4. **The cap is the server's.** `max_squares` changes `span` and therefore every
   `y`, so a client that trimmed the list itself would put every square in the
   wrong place.

## Files

| file | role | state |
|---|---|---|
| `crates/boop-turnstrip` (hafley-rs) | the estimator, the placement and the geometry, in Rust | landed in the working tree |
| `src-tauri/src/1_squares.rs` | the feed: capture, window, layout, tags, one push | edited |
| `src-tauri/src/0_tmux.rs` | `pane_window` — `#{pane_height}` and `#{scroll_position}` in one call | edited |
| `src/0_agentSquaresFeed.ts` | the frame's shape, including `layout` | edited |
| `src/0_agentSquaresSettings.ts` | `agentSquares = { on }` (the cap lives in the crate) | drafted |
| `src/0_agentSquareVisual.ts` | geometry, colour, anims, `SignalCreator` state | drafted |
| `src/1_agentSquaresModel.ts` | `squaresOf(frame)` — hue, header, preview; everything else forwarded | rewritten |
| `src/1_agentSquares.css` | strip, transitions, CSS-only popover | drafted |
| `src/1_agentSquaresMarks.ts` | favorites + the frame's tags per turn id | written |
| `src/1_agentSquares.ts` | `TerminalAgentSquares`: one node per square, the frame as its only input | written |
| `index.html` | `#squares-toggle` beside the other four | edited |
| `src/chrome.ts` | `bindAgentSquaresChrome()` — button state + `syncAgentSquares()` | edited |
| `src/main.ts` | call the bind beside `bindTurnDebugChrome()`, import the CSS | edited |
| `src/terminal.ts` | `applyAgentSquares(tab)` / `syncAgentSquares()`; `Tab.agentSquares`; both dispose paths; applied on open and on a session rebind | edited |
| `scripts/2_agentTuiReplay.ts` | `AgentWrapperRecipe` + `wrappedAgentCommand()` — the `boop tui` line that registers a harness's pane, and the argv/env a wrapper launch needs where a bare one differs | added |
| `e2e-live/3_agent-strip.live.ts` | the live tier: a real CLI in a real pane against pinned llmock, asserting binding → frame → layout → DOM → popover, one PNG per harness | added |
| `playwright.agent.config.ts` | the tier's isolation: scratch HOME, tmux server, boop db, `instant-serve` data-dir, own port | added |

`src/1_agentSquaresEstimate.ts` and its test are deleted: the module they pinned
now lives in `boop-turnstrip`, with the same fixture ported to Rust.

Committed on `.boop-worktrees/feat/agent-squares`; the crate is committed in
`~/projects/hafley-rs` (`32d59379`).

## Verification

- `cargo test -p boop-turnstrip` (hafley-rs) — the estimator's units, including
  the TypeScript fixture replayed as a grid: `kappa_k` recovers the fixture's
  true rows-per-line, `est_rows` stays inside `[L_t, kappa_max · L_t]`,
  `row_est` never inverts, and `y(t)`/`block` stay monotone with the block's
  minimum height at both ends.
- `cargo test --lib` in the worktree — the frame's own units: one square per
  pushed turn, one active square, the window following `pane_height` and
  `scroll_position`, the composer dropped before matching.
- `serve::tests::the_strip_rides_the_events_channel` — the frame reaches a
  subscribed WebSocket as an `events` payload, over `Host::emit`.
- `pnpm vitest run`, `pnpm exec tsc --noEmit` in the worktree — the frame's
  shape, `squaresOf` over a frame fixture, and `squareVars` / `strengthAt` /
  `squareColor` as pure outputs.
- **Live receipt, instant-serve + headless Chromium against real panes** (this
  check is what pinned the two bugs below):
  - A pane's strip, end to end: `squares_watch` on `sprefa-2` (codex) delivered
    `rows=446 turns=21 tags=21 layout.squares=21`; `sprefa-19` (omp) `461/22/22`,
    `ascii-renderer-5` (claude) `62/5/5`, this session's own pane `423/14/14`.
  - Drawn: 21 squares with the server's own `y`/`scale`, one `data-active`,
    `.asq-open` giving `padding-right: 32px` on the terminal, and the window
    block at the window's rows.
  - The popover, on a real turn: `tool · turn 12 · 11:30 PM` + its preview text,
    `opacity: 1`, 360px wide, hanging left of the square.
  - The loop on a scroll: a wheel over the pane parks it in tmux copy-mode, the
    pane repaints, and the strip re-projects from the new capture (3 squares and
    a 92.9px block at the live bottom; more squares and a moved block once the
    copy-mode view is what the capture's tail describes). `-e` returns the pane
    to the live bottom when scrolled back.
- Bug the receipt found: the feed only projected on a pane **write**, so a
  strip attached to an already-idle pane showed nothing until that pane next
  wrote — never, on a settled pane. `run` now projects once on the way in.
- Bug the receipt found: `.asq-host` had `contain: paint`, which clipped the
  360px popover hanging outside its 32px box. It is `contain: layout` now.
- Perf check: with the strip on and a pane producing output, the client issues
  no reads of its own; the feed's capture happens once per `FLUSH_INTERVAL`.

## Decided

1. **One batch read, never n+1.** Settled, not a question. hafley-rs
   `910dc8c5` (`main` `943f8fd0`) adds `Store::tags_for_many(&[String])` in
   `crates/boop-store/src/tags.rs` — one `IN` statement over `agent_tag_link`,
   every source asked for present, an untagged source answering `[]`. The feed
   calls it once per projection over the turns it just located, so the marks
   ride the same frame and no per-square read exists in either path.
   `boop_tags_for` stays only for the single-source case `favorites.ts` already
   uses.
2. **The estimator is a Rust crate, not a client module.**
   `crates/boop-turnstrip` depends on `boop-turnvis` and `serde`, touches no IO,
   and is a pure function of rows + turns + window. Keeping it in the client
   would have meant the same math in two languages the moment anything else
   wanted a strip; keeping it here means the feed, a CLI and a wasm binding all
   call one implementation. `boop-turnvis` itself is untouched — it is a frozen
   byte-identical port with a golden corpus, and the strip composes on its
   public `normalize_turn_line`.
3. **The window is the pane's, not the client's.** Scrolling parks the pane in
   tmux copy-mode, so `#{pane_height}` and `#{scroll_position}` fully determine
   what a client is looking at. The layout therefore rides the push that already
   fires on every pane write, and a client that only draws asks for nothing on
   scroll and nothing per square.
4. **Interaction is hover only.** A click binds nothing and writes nothing; the
   popover and the tooltip are CSS on a pre-rendered child, so the pointer
   arrives in the same frame as the paint.
5. **Uniform squares, clamped flex.** One `SQUARE_H`, one
   `SQUARE_STRIP_MAX`; the scale flexes by estimated size inside
   `[SQUARE_MIN, SQUARE_MAX]`, computed in the crate and forwarded.

## Open

1. **Exit animation.** Entry is a CSS keyframe; a square that leaves the
   projection disappears on the same frame. An exit animation needs a
   short-lived presence list.
2. **Estimator constants.** `ratio_flex`, `scale_min`, `scale_max`, the per-kind
   bucket list and `max_squares` in `boop-turnstrip::Options`, plus the client's
   `SQUARE_*` / `TAG_THROTTLE_MS` CSS mirrors, need measurements from a busy pane
   before they are pinned.
3. **The copy-mode indicator row.** A scrolled pane's top row carries tmux's own
   `[12/340]` indicator, painted by the client and not present in a
   `capture-pane` — so that one row of the window can fail to align and `l_i` can
   come back one low for the turn holding it. The clamps absorb it (never fewer
   rows than lines, never more than `kappa_max`), but the count is worth a
   check on a scrolled pane.
