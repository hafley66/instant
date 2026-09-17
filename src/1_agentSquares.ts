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
// already has by `transform` alone — which is what the CSS transition animates —
// and creates a node only for a turn that was not on the strip before, so the
// entry keyframe runs once per turn rather than once per frame. Per-square state
// is a `SignalCreator` tree (`0_agentSquareVisual`); a frame writes one field per
// square that moved.
import type { Subscription } from "rxjs"
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
import { squaresFeed, watchSquares, type Strip, type StripTurn } from "./1_agentSquaresFeed"
import { marksOf, type TurnMark } from "./1_agentSquaresMarks"
import { squaresOf, type AgentSquare } from "./1_agentSquaresModel"

/** What the server needs to start watching a pane: the pty stream it wakes on,
 *  the boop session whose turns it reads, and the tmux target it captures. */
export type AgentSquaresInput = {
  pty: string
  session: string
  target: string
  socket?: string
}

type Entry = {
  el: HTMLElement
  pop: HTMLElement
  meta: HTMLElement
  body: HTMLElement
  visual: SquareVisual
  subscription: Subscription
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

  constructor(
    private el: HTMLElement,
    private input: AgentSquaresInput,
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
    this.el.append(this.host)
    this.el.classList.add("asq-open")
    this.stop = await watchSquares(this.input)
  }

  /** The pty moved to another boop session (a lane restarted, a pane rebound).
   *  The strip belongs to a session's turns, so it restarts rather than merges. */
  async retarget(input: AgentSquaresInput): Promise<void> {
    if (input.session === this.input.session) {
      this.input = input
      return
    }
    await this.dispose()
    this.disposed = false
    this.input = input
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
    this.el.classList.remove("asq-open")
    this.host.remove()
    await stop?.()
  }

  private render(frame: Strip): void {
    const props = squaresOf(frame)
    if (!props.squares.length && !frame.layout) {
      this.clear()
      return
    }
    const marks = marksOf(frame)
    const turns = new Map(frame.turns.map((turn) => [turn.id, turn]))
    const kept = new Set<string>()
    props.squares.forEach((square, index) => {
      const turn = turns.get(square.id)
      if (!turn) return
      kept.add(square.id)
      const entry = this.entryFor(square)
      reseedSquare(entry.visual, seedOf(square))
      placeSquare(entry.visual, square.y, square.scale, strengthAt(index, props.active))
      activateSquare(entry.visual, square.active)
      this.paintPopover(entry, square, turn, marks.get(square.id))
    })
    for (const [id, entry] of this.entries) {
      if (kept.has(id)) continue
      entry.subscription.unsubscribe()
      entry.el.remove()
      this.entries.delete(id)
    }
    const block = frame.layout?.block
    if (block) {
      this.window.style.setProperty("--asq-win-top", `${block.top}px`)
      this.window.style.setProperty("--asq-win-height", `${block.height}px`)
    }
  }

  private clear(): void {
    for (const entry of this.entries.values()) {
      entry.subscription.unsubscribe()
      entry.el.remove()
    }
    this.entries.clear()
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
    const entry: Entry = { el, pop, meta, body, visual, subscription, stamp: "" }
    this.strip.append(el)
    this.entries.set(square.id, entry)
    return entry
  }

  private paintPopover(entry: Entry, square: AgentSquare, turn: StripTurn, mark: TurnMark | undefined): void {
    const marks = mark ?? { favorite: false, tags: [] }
    const stamp = `${turn.ts}:${square.role}:${marks.favorite}:${marks.tags.join(",")}:${turn.said.length}`
    if (entry.stamp === stamp) return
    entry.stamp = stamp
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
