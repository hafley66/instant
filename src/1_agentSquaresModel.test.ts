// The strip's own arithmetic: what the server's units become once the pane's row
// height is known, and what a turn's text looks like before it reaches a
// popover. Both are the client's only numbers — everything else is forwarded.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest"
import { SQUARE_STEP, type SquareKind } from "./0_agentSquareVisual"
import { TerminalAgentSquares } from "./1_agentSquares"
import { boxMoved, previewOf, recentOffset, squaresOf } from "./1_agentSquaresModel"
import type { Strip, StripLayout, StripTurn } from "./1_agentSquaresFeed"

// The wheel test drives the strip through its real component, so the feed and
// the turn panel are stubbed at the module seam: the feed hands the component a
// controllable frame stream and the panel is a no-op, keeping the test off the
// native transport and off React.
const feedMock = vi.hoisted(() => ({ frames: null as unknown as import("rxjs").Subject<Strip> }))
vi.mock("./1_agentSquaresFeed", async () => {
  const { Subject } = await import("rxjs")
  feedMock.frames = new Subject<Strip>()
  return {
    squaresFeed: () => feedMock.frames,
    watchSquares: async () => async () => {},
  }
})
vi.mock("./1_turnPanel", () => {
  class TurnPanel {
    isOpen = false
    open() {}
    close() {}
    dispose() {}
  }
  return { TurnPanel }
})
// `marksOf` reaches `favorites` and through it the whole app (reactdock, the
// panel grid, pdfjs), which is not a unit-test surface: an empty marks map is
// all the component test draws popovers from.
vi.mock("./1_agentSquaresMarks", () => ({
  marksOf: () => new Map(),
}))

const turn = (id: string, role: string, said: string, ts: number): StripTurn => ({
  session: "s1",
  harness: "claude",
  turn: Number(id.split(":")[1]),
  ts,
  role,
  said,
  id,
  bufferStart: 0,
  bufferEnd: 0,
  anchorStart: 0,
  anchorEnd: 0,
  confidence: "anchored",
})

const TURNS: StripTurn[] = [
  turn("s1:2", "assistant", "line one\nline two", 1_700_000_000_000),
  turn("s1:3", "tool", "sqlite3 --version", 1_700_000_100_000),
]

const frame = (layout: StripLayout, pinned: StripTurn[] = [], turns: StripTurn[] = TURNS): Strip => ({
  session: "s1",
  at: 1_700_000_000_000,
  rows: 40,
  turns,
  pinned,
  tags: {},
  layout,
})

/** The wire type itself: `map`'s `block` and `span` are gone from the frame, so
 *  a client cannot branch on either. */
type HasKey<T, K extends string> = K extends keyof T ? true : false
const RECENT: HasKey<Extract<StripLayout, { mode: "recent" }>, "block"> = false
const RECENT_SPAN: HasKey<Extract<StripLayout, { mode: "recent" }>, "span"> = false

describe("the strip's own numbers", () => {
  it("puts a relative square on its own row and the band in its own lane", () => {
    const props = squaresOf(
      frame(
        {
          mode: "relative",
          rows: 24,
          band: 1,
          squares: [
            { id: "s1:1", kind: "user", y: 0, scale: 1, active: false },
            { id: "s1:2", kind: "agent", y: 5, scale: 1.2, active: true },
            { id: "s1:3", kind: "tool", y: 9, scale: 0.9, active: false },
          ],
        },
        [turn("s1:1", "user", "the prompt above the window", 1_699_999_000_000)],
      ),
      { cellHeight: 17, track: 320 },
    )

    expect(props).toMatchInlineSnapshot(`
      {
        "active": 1,
        "band": 1,
        "squares": [
          {
            "active": false,
            "at": "user · turn 1 · 04:56 PM",
            "hue": 264,
            "id": "s1:1",
            "kind": "user",
            "pinned": true,
            "preview": "the prompt above the window",
            "role": "user",
            "scale": 1,
            "turn": 1,
            "y": 0,
          },
          {
            "active": true,
            "at": "assistant · turn 2 · 05:13 PM",
            "hue": 33,
            "id": "s1:2",
            "kind": "agent",
            "pinned": false,
            "preview": "line one
      line two",
            "role": "assistant",
            "scale": 1.2,
            "turn": 2,
            "y": 85,
          },
          {
            "active": false,
            "at": "tool · turn 3 · 05:15 PM",
            "hue": 350,
            "id": "s1:3",
            "kind": "tool",
            "pinned": false,
            "preview": "sqlite3 --version",
            "role": "tool",
            "scale": 0.9,
            "turn": 3,
            "y": 153,
          },
        ],
        "track": 408,
      }
    `)
    // The map's window block is gone with its mode: nothing rides the props.
    expect(Object.keys(props).sort()).toEqual(["active", "band", "squares", "track"])
  })

  it("centers the recent block independently of which squares are active", () => {
    const turns = [
      turn("s1:1", "user", "the opening prompt", 1_699_999_000_000),
      turn("s1:2", "agent", "line one\nline two", 1_700_000_000_000),
      turn("s1:3", "agent", "and the reply", 1_700_000_100_000),
    ]
    const recentFrame = (active: number) =>
      frame(
        {
          mode: "recent",
          rows: 24,
          squares: [
            { id: "s1:1", kind: "user" as SquareKind, y: 0, scale: 1, active: active === 0 },
            { id: "s1:2", kind: "agent" as SquareKind, y: 1, scale: 1, active: active === 1 },
            { id: "s1:3", kind: "agent" as SquareKind, y: 2, scale: 1, active: active === 2 },
          ],
        },
        [],
        turns,
      )
    const props = squaresOf(recentFrame(1), { cellHeight: 17, track: 320 })

    // The whole track *is* the recent strip's space: no rows of its own to
    // convert, and no band counted in.
    expect(props.track).toBe(320)
    expect(props.band).toBe(0)
    expect(props.active).toBe(1)
    // The reader's line is the pane's bottom edge, and the turn being read sits
    // on it: the older turn above, the newer one below. A centred block would
    // put the same squares 60px higher and never move them.
    const line = 320 / 2
    expect(props.squares.map((square) => square.y)).toEqual([line - SQUARE_STEP, line, line + SQUARE_STEP])
    // Scrolling back one turn restacks the block around the new anchor, so the
    // square that is newer than the turn being read slides toward the edge.
    expect(squaresOf(recentFrame(0), { cellHeight: 17, track: 320 }).squares.map((square) => square.y)).toEqual([
      line - SQUARE_STEP,
      line,
      line + SQUARE_STEP,
    ])
    // Uniform: a recent square's size is never its turn's, and none is pinned.
    expect(props.squares.map((square) => square.scale)).toEqual([1, 1, 1])
    expect(props.squares.some((square) => square.pinned)).toBe(false)

    // A block deeper than the reader's line is pushed down rather than run off
    // the top: the oldest square starts at the strip's own top and the newest
    // ends up furthest down, which is the one clamp this layout has.
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `s1:${index + 1}`,
      kind: "agent" as SquareKind,
      y: index,
      scale: 1,
      active: false,
    }))
    const overfull = squaresOf(
      frame(
        { mode: "recent", rows: 24, squares: many },
        [],
        many.map((square, index) => turn(square.id, "assistant", "a reply", 1_699_999_000_000 + index)),
      ),
      { cellHeight: 17, track: 320 },
    )
    expect(overfull.squares.map((square) => square.y)).toEqual(
      many.map((_, index) => index * SQUARE_STEP),
    )
  })

  it("drops the wire type's map fields", () => {
    expect([RECENT, RECENT_SPAN]).toEqual([false, false])
  })

  it("turns the store's escaped text back into words", () => {
    expect(
      previewOf(
        "INFO \\u001b[2m2026-09-17T18:51:02Z\\u001b[0m\\nnext \\x1b[32mline\\u001b[0m done",
      ),
    ).toMatchInlineSnapshot(`
      "INFO 2026-09-17T18:51:02Z
      next line done"
    `)
  })
})

describe("the recent block's scroll", () => {
  it("clamps the held offset to what the track can show", () => {
    // Dragging toward the newer tail stops when the newest square reaches the
    // pane's bottom: `track - block`.
    expect(recentOffset(-1000, 320, 663)).toBe(320 - 663)
    // Dragging back toward the older top stops at 0.
    expect(recentOffset(50, 320, 663)).toBe(0)
    // A block that fits the track cannot scroll at all.
    expect(recentOffset(-50, 320, 68)).toBe(0)
  })

it("moves the recent block by the offset without reordering it", () => {
    const base = squaresOf(recentFrame(40), { cellHeight: 17, track: 320 }, 0)
    const shifted = squaresOf(recentFrame(40), { cellHeight: 17, track: 320 }, -200)
    // Same squares, same order, every `y` moved by the offset; recent has no
    // band, so none appears.
    expect(shifted.squares.map((square) => square.id)).toEqual(base.squares.map((square) => square.id))
    expect(shifted.squares.map((square) => square.y)).toEqual(base.squares.map((square) => square.y - 200))
    expect(shifted.band).toBe(0)
  })

  it("scrolls an overflowing recent block from the gutter wheel", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb()
      return 1
    })
    const { el } = mountPane(320)
    const component = new TerminalAgentSquares(
      el,
      { pty: "p1", session: "s1", target: "t1" },
      { mode: "recent", userKeep: 4 },
      () => {},
    )
    await component.start()
    const overflow = recentFrame(40)
    feedMock.frames!.next(overflow)
    const host = el.querySelector<HTMLElement>(".asq-host")!
    expect(host.dataset.scrollable).toBe("true")
    const oldest = el.querySelector<HTMLElement>(".asq")!
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("0px")
    // A wheel toward the tail is consumed and repaints from the last frame (the
    // wheel's own `requestAnimationFrame` re-runs `render`), so the drawn block
    // shifts even though no new server frame follows.
    const wheel = new WheelEvent("wheel", { deltaY: -200, deltaMode: 0, cancelable: true })
    host.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("-200px")
    await component.dispose()
  })

  it("lets the wheel pass through when the recent block fits", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb()
      return 1
    })
    const { el } = mountPane(320)
    const component = new TerminalAgentSquares(
      el,
      { pty: "p1", session: "s1", target: "t1" },
      { mode: "recent", userKeep: 4 },
      () => {},
    )
    await component.start()
    const small = recentFrame(5)
    feedMock.frames!.next(small)
    const host = el.querySelector<HTMLElement>(".asq-host")!
    expect(host.dataset.scrollable).toBeUndefined()
    const oldest = el.querySelector<HTMLElement>(".asq")!
    const before = oldest.style.getPropertyValue("--asq-y")
    const wheel = new WheelEvent("wheel", { deltaY: -200, deltaMode: 0, cancelable: true })
    host.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    feedMock.frames!.next(small)
    expect(oldest.style.getPropertyValue("--asq-y")).toBe(before)
    await component.dispose()
  })
})

describe("a frame held while the reader is in the strip", () => {
  it("draws nothing while the pointer is inside, then the newest frame once", async () => {
    const { el } = mountPane(320)
    const component = new TerminalAgentSquares(
      el,
      { pty: "p1", session: "s1", target: "t1" },
      { mode: "recent", userKeep: 4 },
      () => {},
    )
    await component.start()
    feedMock.frames!.next(recentFrame(5))
    const host = el.querySelector<HTMLElement>(".asq-host")!
    const oldest = el.querySelector<HTMLElement>(".asq")!
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("126px")
    host.dispatchEvent(new Event("pointerenter"))
    // Each pushed frame is stored, not drawn: the strip keeps its places and
    // keeps the squares the first frame made.
    feedMock.frames!.next(recentFrame(6))
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("126px")
    expect(el.querySelectorAll(".asq").length).toBe(5)
    feedMock.frames!.next(recentFrame(7))
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("126px")
    // Leaving paints the newest held frame once: the middle frame's places
    // never reach the strip.
    host.dispatchEvent(new Event("pointerleave"))
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("109px")
    expect(el.querySelectorAll(".asq").length).toBe(7)
    await component.dispose()
  })

  it("keeps the hold while either presence stays, and paints when both go", async () => {
    const { el } = mountPane(320)
    const component = new TerminalAgentSquares(
      el,
      { pty: "p1", session: "s1", target: "t1" },
      { mode: "recent", userKeep: 4 },
      () => {},
    )
    await component.start()
    feedMock.frames!.next(recentFrame(5))
    const host = el.querySelector<HTMLElement>(".asq-host")!
    const oldest = el.querySelector<HTMLElement>(".asq")!
    host.dispatchEvent(new Event("pointerenter"))
    host.dispatchEvent(new FocusEvent("focusin"))
    feedMock.frames!.next(recentFrame(7))
    // The pointer left, but keyboard focus is still in the strip: held.
    host.dispatchEvent(new Event("pointerleave"))
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("126px")
    host.dispatchEvent(new FocusEvent("focusout"))
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("109px")
    await component.dispose()
  })

  it("keeps the wheel live during the hold, repainting the held frame", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb()
      return 1
    })
    const { el } = mountPane(320)
    const component = new TerminalAgentSquares(
      el,
      { pty: "p1", session: "s1", target: "t1" },
      { mode: "recent", userKeep: 4 },
      () => {},
    )
    await component.start()
    feedMock.frames!.next(recentFrame(40))
    const host = el.querySelector<HTMLElement>(".asq-host")!
    const oldest = el.querySelector<HTMLElement>(".asq")!
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("0px")
    host.dispatchEvent(new Event("pointerenter"))
    // Held, not drawn: only this frame marks the newest square active.
    feedMock.frames!.next(withActiveTail(recentFrame(40)))
    const newest = el.querySelector<HTMLElement>('[data-turn="s1:40"]')!
    expect(newest.dataset.active).toBe("false")
    const wheel = new WheelEvent("wheel", { deltaY: -200, deltaMode: 0, cancelable: true })
    host.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    // The scroll repainted the held frame: the block moved and the active
    // mark landed with it.
    expect(oldest.style.getPropertyValue("--asq-y")).toBe("-200px")
    expect(newest.dataset.active).toBe("true")
    await component.dispose()
  })
})

/** A recent frame with `count` uniform agent squares, all in the frame's turns,
 *  so every one of them draws. */
function recentFrame(count: number): Strip {
  const squares = Array.from({ length: count }, (_, index) => ({
    id: `s1:${index + 1}`,
    kind: "agent" as SquareKind,
    y: index,
    scale: 1,
    active: false,
  }))
  const turns = squares.map((square, index) =>
    turn(square.id, "assistant", "a reply", 1_699_999_000_000 + index),
  )
  return frame({ mode: "recent", rows: 40, squares }, [], turns)
}

/** A copy of a recent `frame` with the newest square active, so a paint of
 *  exactly this frame is observable in `data-active`. */
function withActiveTail(base: Strip): Strip {
  const layout = base.layout as Extract<StripLayout, { mode: "recent" }>
  layout.squares = layout.squares.map((square, index) => ({
    ...square,
    active: index === layout.squares.length - 1,
  }))
  return base
}

/** A pane the strip can measure in jsdom: `getBoundingClientRect` is a no-op
 *  there, so the strip's track (which reads the pane's box) is pinned to the
 *  height the test chooses. */
function mountPane(height: number): { el: HTMLElement } {
  const el = document.createElement("div")
  el.dataset.rows = "40"
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    bottom: height,
    right: 32,
    width: 32,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  return { el }
}
describe("a resize the strip answers", () => {
  const drawn = { width: 800, height: 600 }
  it("repaints when the pane's box moves off the one the strip drew at", () => {
    expect(boxMoved(drawn, 700, 600)).toBe(true)
    expect(boxMoved(drawn, 800, 640)).toBe(true)
    expect(boxMoved(drawn, 700.5, 600)).toBe(true)
  })
  it("sits still while the box repeats, sub-pixel drift included", () => {
    expect(boxMoved(drawn, 800, 600)).toBe(false)
    expect(boxMoved(drawn, 800.4, 600.4)).toBe(false)
  })
  it("has nothing to re-project before the first frame", () => {
    expect(boxMoved(undefined, 700, 600)).toBe(false)
  })
})
