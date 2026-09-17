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
  squareVars,
  strengthAt,
  type SquareSeed,
  type SquareVisual,
} from "./0_agentSquareVisual"
import { liveProbe } from "./0_liveProbe"
import { squaresFeed, watchSquares, type Strip, type StripTurn } from "./1_agentSquaresFeed"
import { marksOf, type TurnMark } from "./1_agentSquaresMarks"
import { squaresOf, type AgentSquare, type SquareGeometry } from "./1_agentSquaresModel"
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
  private window = document.createElement("div")
  private entries = new Map<string, Entry>()
  private frames?: Subscription
  private stop?: () => Promise<void>
  private disposed = false
  private panel?: TurnPanel
  /** The square the panel was last opened for. A click on that square is the
   *  reader saying they are done with its card, so the strip closes the panel it
   *  opened rather than opening the card again at the same spot. */
  private panelId?: string

  constructor(
    private el: HTMLElement,
    private input: AgentSquaresInput,
    private options: SquaresOptions,
  ) {
    this.host.className = "asq-host"
    this.strip.className = "asq-strip"
    this.window.className = "asq-window"
    this.strip.append(this.window)
    this.host.append(this.strip)
  }

  /** Subscribe first, then start the watcher: a frame that lands between the two
   *  is kept rather than dropped. */
  async start(): Promise<void> {
    this.frames = squaresFeed(this.input.session).subscribe((frame) => this.render(frame))
    this.panel ??= new TurnPanel(this.el)
    this.el.append(this.host)
    this.el.classList.add("asq-open")
    this.stop = await watchSquares(this.input, this.options)
  }

  /** The pane moved to another boop session, or the reader changed what the
   *  strip draws (a mode, the tools, the size of the band). Either way it is a
   *  different projection, so the watcher restarts rather than merges. The
   *  options arrive rebuilt on every settings sync, so the comparison is by
   *  value: an equal pair costs nothing. */
  async retarget(input: AgentSquaresInput, options: SquaresOptions): Promise<void> {
    const same =
      input.pty === this.input.pty &&
      input.session === this.input.session &&
      input.target === this.input.target &&
      input.socket === this.input.socket &&
      options.mode === this.options.mode &&
      options.showTools === this.options.showTools &&
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
    const pane = this.el.getBoundingClientRect()
    const props = squaresOf(frame, this.geometry(frame))
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
      placeSquare(entry.visual, square.y, square.scale, strengthAt(index, props.active, square.kind))
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
    const block = props.block
    if (block) {
      this.window.style.setProperty("--asq-win-top", `${block.top}px`)
      this.window.style.setProperty("--asq-win-height", `${block.height}px`)
    }
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

  private clear(): void {
    for (const entry of this.entries.values()) {
      entry.subscription.unsubscribe()
      entry.el.remove()
    }
    this.entries.clear()
    // No layout means no map, so the block goes with it rather than sitting at
    // whatever the last frame left behind.
    delete this.strip.dataset.mode
  }

  private entryFor(square: AgentSquare): Entry {
    const existing = this.entries.get(square.id)
    if (existing) return existing
    const el = document.createElement("div")
    el.className = "asq"
    el.tabIndex = 0
    el.dataset.turn = square.id
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