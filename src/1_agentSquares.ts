// The strip itself: one square per turn the server placed, in the terminal's
// right margin.
//
// It draws and nothing else. Where a square sits, how big it draws and which one
// is being read are the server's numbers (`boop-turnstrip` computed them from a
// pane capture and tmux's own window), and the frame that carries them is the
// only input this class has: no read on scroll, no read per square, no query at
// hover.
//
// One DOM node per square, kept across frames. A re-projection moves the nodes it
// already has by `transform` alone (which is what the CSS transition animates)
// and creates a node only for a turn that was not on the strip before, so the
// entry keyframe runs once per turn rather than once per frame. Per-square state
// is a `SignalCreator` tree (`0_agentSquareVisual`); a frame writes one field per
// square that moved.
//
// The one thing the pointer writes is the turn panel: a click on a square opens
// it, and a second click on the same square closes it. Hover stays CSS-only.
import type { Subscription } from "rxjs"
import type { SquaresOptions } from "./0_agentSquaresSettings"
import {
  activateSquare,
  createSquareVisual,
  placeSquare,
  reseedSquare,
  SQUARE_STEP,
  squareVars,
  strengthAt,
  type SquareSeed,
  type SquareVisual,
} from "./0_agentSquareVisual"
import { liveProbe } from "./0_liveProbe"
import { squaresFeed, watchSquares, type Strip, type StripTurn } from "./1_agentSquaresFeed"
import { marksOf, type TurnMark } from "./1_agentSquaresMarks"
import {
  boxMoved,
  recentOffset,
  squaresOf,
  type AgentSquare,
  type AgentSquaresProps,
  type SquareBox,
  type SquareGeometry,
} from "./1_agentSquaresModel"
import { TurnPanel, type TurnPanelTarget } from "./1_turnPanel"

/** What the server needs to start watching a pane: the pty stream it wakes on,
 *  the boop session whose turns it reads, and the tmux target it captures. */
export type AgentSquaresInput = {
  pty: string
  session: string
  target: string
  socket?: string
}

/** How far down the pane a square can sit before it opens its popover upward
 *  instead. A popover is centred on its square, so only half of one hangs below
 *  it; this is comfortably more than the tallest half-popover, which keeps the
 *  flip rare while still catching every square the pane's bottom would cut. */
const POP_FLIP = 140

/** How far down the pane a square can sit before a centred popover would be cut
 *  by the pane's top edge. The same half-popover as `POP_FLIP`, measured from the
 *  other end: a square this close to the top anchors its popover to its own top
 *  and lets it hang down, which is the one case the flip cannot cover. */
const POP_ANCHOR = 60

type Entry = {
  el: HTMLElement
  pop: HTMLElement
  meta: HTMLElement
  body: HTMLElement
  visual: SquareVisual
  subscription: Subscription
  /** Everything the panel opens with but the click point, refreshed with the
   *  popover: the panel never re-reads the store for a turn the frame already
   *  carried. Absent until the square's first frame paints it. */
  target?: Omit<TurnPanelTarget, "x" | "y">
  /** What the popover was last built from, so a frame with the same marks does
   *  no DOM work at all. */
  stamp: string
}

function markLine(mark: TurnMark): string {
  const parts: string[] = []
  if (mark.favorite) parts.push("★")
  for (const tag of mark.tags) parts.push(`#${tag}`)
  return parts.join(" ")
}

export class TerminalAgentSquares {
  private host = document.createElement("div")
  private strip = document.createElement("div")
  private gap = document.createElement("div")
  private entries = new Map<string, Entry>()
  private frames?: Subscription
  private stop?: () => Promise<void>
  private disposed = false
  private panel?: TurnPanel
  /** The square the panel was last opened for. A click on that square is the
   *  reader saying they are done with its card, so the strip closes the panel it
   *  opened rather than opening the card again at the same spot. */
  private panelId?: string
  /** The recent block's scroll, in px, held between frames and re-clamped on
   *  each one (a new frame can shrink the block). A view fact: the server never
   *  learns it. */
  private recentOffsetPx = 0
  /** The wheel's raw delta, accumulated across events in the same frame and
   *  applied once on the next animation frame, so a burst of wheel events lands
   *  as one clamp instead of a clamp per event. */
  private wheelPending = 0
  /** The frame the strip last drew, held so the wheel and a pane resize can
   *  repaint without waiting for a server push: a quiet pane sends no
   *  `squares-update`, and the pane settling after a tab change is a view
   *  fact the server never learns. */
  private lastFrame?: Strip
  private wheelFrame = 0
  /** The pane box the last render projected into, rounded px: the box a resize
   *  has to move off before the strip repaints. */
  private drawn?: SquareBox
  /** The pane's resize observer, and the one repaint a burst of entries
   *  coalesces into on the next animation frame. */
  private resize?: ResizeObserver
  private resizeFrame = 0

  constructor(
    private el: HTMLElement,
    private input: AgentSquaresInput,
    private options: SquaresOptions,
    /** The pane's usable width just changed: `asq-open` is the only place that
     *  knows the gutter opened, and the terminal has to measure its columns
     *  again from here — the flip is not otherwise observable. */
    private onGutter: () => void,
    /** The pane's resize observer arrives through a seam, the browser's own by
     *  default, so a test can stand in for it. */
    private newResize: typeof ResizeObserver = ResizeObserver,
  ) {
    this.host.className = "asq-host"
    this.strip.className = "asq-strip"
    this.gap.className = "asq-tool-gap"
    this.gap.hidden = true
    this.strip.append(this.gap)
    this.host.append(this.strip)
    // The host is `pointer-events: none` so the terminal keeps its own wheel;
    // the strip's own scroll only takes the wheel when the block overflows
    // (`data-scrollable`, set per frame), and this listener passes it through
    // otherwise. `passive: false` because the handler calls `preventDefault`
    // only in the overflow case.
    this.host.addEventListener("wheel", this.onWheel, { passive: false })
  }

  /** Subscribe first, then start the watcher: a frame that lands between the two
   *  is kept rather than dropped. */
  async start(): Promise<void> {
    this.frames = squaresFeed(this.input.session).subscribe((frame) => this.render(frame))
    this.resize ??= new this.newResize((entries) => this.resized(entries))
    this.resize.observe(this.el)
    this.panel ??= new TurnPanel(this.el)
    this.el.append(this.host)
    this.el.classList.add("asq-open")
    this.onGutter()
    this.stop = await watchSquares(this.input, this.options)
  }

  /** The pane moved to another boop session, or the reader changed what the
   *  strip draws (a mode, the size of the band). Either way it is a different
   *  projection, so the watcher restarts rather than merges. The options arrive
   *  rebuilt on every settings sync, so the comparison is by value: an equal
   *  pair costs nothing. */
  async retarget(input: AgentSquaresInput, options: SquaresOptions): Promise<void> {
    const same =
      input.pty === this.input.pty &&
      input.session === this.input.session &&
      input.target === this.input.target &&
      input.socket === this.input.socket &&
      options.mode === this.options.mode &&
      options.userKeep === this.options.userKeep
    if (same) {
      this.input = input
      this.options = options
      return
    }
    await this.dispose()
    this.disposed = false
    this.input = input
    this.options = options
    await this.start()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.frames?.unsubscribe()
    this.frames = undefined
    this.host.removeEventListener("wheel", this.onWheel)
    this.lastFrame = undefined
    this.resize?.disconnect()
    this.resize = undefined
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame)
    this.resizeFrame = 0
    const stop = this.stop
    this.stop = undefined
    for (const entry of this.entries.values()) {
      entry.subscription.unsubscribe()
      entry.el.remove()
    }
    this.entries.clear()
    this.panel?.dispose()
    this.panel = undefined
    this.panelId = undefined
    this.el.classList.remove("asq-open")
    this.host.remove()
    this.onGutter()
    await stop?.()
  }

  /** Open one square's turn panel, or close it when it is already the panel's.
   *  The point is the click, in the pane's own coordinates; a caller with no
   *  click gets the square's own centre. */
  openPanel(id: string, point?: { x: number; y: number }): void {
    const entry = this.entries.get(id)
    const panel = this.panel
    if (!entry?.target || !panel) return
    // The panel is asked rather than assumed: Escape and a click on the pane
    // both close it without this class hearing about it, and a square whose
    // panel is already gone is a square that opens one.
    if (this.panelId === id && panel.isOpen) {
      panel.close()
      this.panelId = undefined
      return
    }
    const rect = entry.el.getBoundingClientRect()
    const pane = this.el.getBoundingClientRect()
    panel.open({
      ...entry.target,
      x: point?.x ?? rect.left - pane.left + rect.width / 2,
      y: point?.y ?? rect.top - pane.top + rect.height / 2,
    })
    this.panelId = id
  }

  private render(frame: Strip): void {
    this.lastFrame = frame
    const pane = this.el.getBoundingClientRect()
    const geometry = this.geometry(frame)
    this.drawn = { width: Math.round(pane.width), height: Math.round(pane.height) }
    const props = squaresOf(frame, geometry, this.recentOffsetPx)
    this.syncScroll(frame, props, geometry)
    this.gap.hidden = !props.gap
    if (props.gap) this.gap.style.transform = `translateY(${props.gap.y}px)`
    // One sample per drawn frame, through the app's own probe: this is the only
    // place that knows how many squares a projection ended up drawing and where.
    liveProbe.record({
      kind: "render",
      name: "squares.frame",
      detail: {
        mode: frame.layout?.mode ?? "none",
        squares: props.squares.length,
        band: props.band,
        track: Math.round(props.track),
        pane: Math.round(pane.height),
      },
    })
    // The pane's own px, on the strip: the track a square's `y` is measured in,
    // and the box the popovers are clamped inside.
    this.strip.style.setProperty("--asq-track", `${props.track}px`)
    this.strip.style.setProperty("--asq-pane", `${pane.height}px`)
    this.strip.style.setProperty("--asq-pane-w", `${pane.width}px`)
    if (!frame.layout) {
      this.clear()
      return
    }
    this.strip.dataset.mode = frame.layout.mode
    const marks = marksOf(frame)
    const turns = new Map([...frame.turns, ...frame.pinned].map((turn) => [turn.id, turn]))
    const kept = new Set<string>()
    props.squares.forEach((square, index) => {
      const turn = turns.get(square.id)
      if (!turn) return
      kept.add(square.id)
      const entry = this.entryFor(square)
      reseedSquare(entry.visual, seedOf(square))
      placeSquare(entry.visual, square.y, square.scale, strengthAt(index, square.active ? index : props.active, square.kind))
      activateSquare(entry.visual, square.active)
      // A square low enough that its popover would run past the pane's bottom
      // edge opens upward instead, and one close enough to the top that a
      // centred popover would be cut hangs downward from its own top. Between
      // the two, the popover stays centred, which is where it reads best.
      if (square.y + POP_FLIP > pane.height) entry.el.dataset.pop = "up"
      else if (square.y < POP_ANCHOR) entry.el.dataset.pop = "down"
      else delete entry.el.dataset.pop
      if (square.pinned) entry.el.dataset.band = "true"
      else delete entry.el.dataset.band
      this.paintPopover(entry, square, turn, marks.get(square.id))
    })
    for (const [id, entry] of this.entries) {
      if (kept.has(id)) continue
      entry.subscription.unsubscribe()
      entry.el.remove()
      this.entries.delete(id)
    }
  }

  /** The pane's box moved under a drawn strip: re-project the held frame on
   *  the next animation frame, one per burst. This is what replaces the
   *  pre-measure track a tab change can leave one frame behind, and it never
   *  reaches the server: a resize is a view fact. */
  private resized(entries: ResizeObserverEntry[]): void {
    if (!this.lastFrame || !this.drawn) return
    const box = entries[entries.length - 1]?.contentRect
    if (!box || !boxMoved(this.drawn, box.width, box.height)) return
    if (this.resizeFrame) return
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = 0
      if (this.lastFrame) this.render(this.lastFrame)
    })
  }

  /**
   * The pane's own px. `.xterm-screen` is the rows box, sized to
   * `rows * cellHeight` by the fit addon, so one row is that box over the pane's
   * row count. The count comes from the pane element when it carries one
   * (`data-rows`), and otherwise from the frame's relative window: in relative
   * mode the window is the pane's own rows (`#{pane_height}`), which is the
   * number xterm calls `rows`. The last resort is the pane's box over that same
   * count, which is what a pane with no screen element at all can offer.
   *
   * The strip has no terminal handle, so none of this can come from `term.rows`.
   */
  private geometry(frame: Strip): SquareGeometry {
    const screen = this.el.querySelector<HTMLElement>(".xterm-screen")
    const pane = this.el.getBoundingClientRect()
    const declared = Number(this.el.dataset.rows ?? 0)
    const layout = frame.layout
    const rows = declared || (layout?.mode === "relative" ? layout.rows : 0)
    return {
      cellHeight: screen && rows > 0 ? screen.clientHeight / rows : Math.round(pane.height / Math.max(1, rows)),
      track: screen?.clientHeight || pane.height,
    }
  }

  /** Keep the held recent offset honest against this frame: re-clamp it (a new
   *  frame can shrink the block), and tell the host whether it may take the
   *  wheel at all — only a recent block taller than the track scrolls, so only
   *  then does `data-scrollable` lift the host's `pointer-events` off `none`
   *  and let the wheel land. Anything else — a fitting recent strip, a relative
   *  strip, a strip with no layout — keeps today's pass-through to the terminal
   *  and drops whatever scroll was being held. */
  private syncScroll(frame: Strip, props: AgentSquaresProps, geometry: SquareGeometry): void {
    if (frame.layout?.mode !== "recent") {
      this.recentOffsetPx = 0
      delete this.host.dataset.scrollable
      return
    }
    const block = (props.squares.length - 1) * SQUARE_STEP
    this.recentOffsetPx = recentOffset(this.recentOffsetPx, geometry.track, block)
    if (block > geometry.track) this.host.dataset.scrollable = "true"
    else delete this.host.dataset.scrollable
  }

  /** The recent block scrolls from the gutter wheel, like the terminal's own
   *  scroller, but nothing else does: the strip gives up the wheel to the
   *  terminal whenever `data-scrollable` is absent, so this never runs. The
   *  events coalesce on the animation frame and land as one clamp. */
  private onWheel = (event: WheelEvent): void => {
    if (!this.host.dataset.scrollable) return
    event.preventDefault()
    // The offset is px and `SQUARE_STEP` is the px between places, so a line
    // delta converts to the same spacing the strip itself uses.
    this.wheelPending +=
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * SQUARE_STEP
    if (this.wheelFrame) return
    this.wheelFrame = requestAnimationFrame(() => {
      this.wheelFrame = 0
      const delta = this.wheelPending
      this.wheelPending = 0
      this.recentOffsetPx += delta
      // Repaint from the last frame so the moved block shows immediately: a
      // quiet pane sends no server push, so this is the only frame that knows
      // the offset changed. `render` re-runs the same clamp, so this is the
      // server frame's own paint path, not a second one.
      if (this.lastFrame) this.render(this.lastFrame)
    })
  }

  private clear(): void {
    this.gap.hidden = true
    for (const entry of this.entries.values()) {
      entry.subscription.unsubscribe()
      entry.el.remove()
    }
    this.entries.clear()
    // No layout means no placement, so the mode goes with it rather than
    // sitting at whatever the last frame left behind.
    delete this.strip.dataset.mode
  }

  private entryFor(square: AgentSquare): Entry {
    const existing = this.entries.get(square.id)
    if (existing) return existing
    const el = document.createElement("div")
    el.className = "asq"
    el.tabIndex = 0
    el.dataset.turn = square.id
    // The kind is fixed for a square's lifetime, so it is stamped once at
    // creation and CSS keys sizing and the hit target off it.
    el.dataset.kind = square.kind
    const pop = document.createElement("div")
    pop.className = "asq-pop"
    const meta = document.createElement("div")
    meta.className = "asq-pop-meta"
    const body = document.createElement("div")
    body.className = "asq-pop-body"
    pop.append(meta, body)
    el.append(pop)
    // `pointerup`, not `click`: this app's pointerdown handlers (the context
    // gutter's hover check, the pinned selection) run between a press and its
    // release, and a click is only delivered to the nearest common ancestor of
    // the two when the node under the pointer changes — which is how a press on
    // a square ends up delivering its click to the pane instead of the square.
    // The terminal's own cmd-click gesture is routed on `pointerup` for the same
    // reason.
    el.addEventListener("pointerup", (event) => {
      const pane = this.el.getBoundingClientRect()
      this.openPanel(square.id, { x: event.clientX - pane.left, y: event.clientY - pane.top })
    })
    const visual = createSquareVisual(seedOf(square))
    // The element writes itself from its own state, so a frame touches a square
    // exactly once and the CSS owns the interpolation from there.
    const subscription = visual.$.subscribe((state) => {
      for (const [name, value] of Object.entries(squareVars(state))) el.style.setProperty(name, value)
      el.dataset.active = String(state.active)
      // The browser tooltip is the cheap half of the hover affordance; the
      // popover is the body, rendered here with the square.
      el.title = state.at
    })
    const entry: Entry = {
      el,
      pop,
      meta,
      body,
      visual,
      subscription,
      stamp: "",
    }
    this.strip.append(el)
    this.entries.set(square.id, entry)
    return entry
  }

  private paintPopover(entry: Entry, square: AgentSquare, turn: StripTurn, mark: TurnMark | undefined): void {
    const marks = mark ?? { favorite: false, tags: [] }
    const stamp = `${turn.ts}:${square.role}:${marks.favorite}:${marks.tags.join(",")}:${turn.said.length}`
    if (entry.stamp === stamp) return
    entry.stamp = stamp
    entry.target = {
      id: square.id,
      // The same source favorites and tags are keyed by, so the panel's actions
      // and the marks module never disagree about which turn this is.
      source: `turn:${turn.session}:${turn.turn}`,
      // The frame's own turn, so the panel writes a favorite from what it was
      // handed rather than looking the turn up in the ledger window, which has
      // forgotten every turn the band keeps.
      turn,
      at: square.at,
      preview: square.preview,
      marks,
    }
    const line = markLine(marks)
    entry.meta.textContent = square.at
    entry.body.textContent = line ? `${line}\n${square.preview}` : square.preview
  }
}

/** The slice of an `AgentSquare` a visual carries: everything the element draws
 *  from, with the placement fields left to `placeSquare`. */
function seedOf(square: AgentSquare): SquareSeed {
  return {
    id: square.id,
    kind: square.kind,
    role: square.role,
    turn: square.turn,
    hue: square.hue,
    at: square.at,
    preview: square.preview,
  }
}
