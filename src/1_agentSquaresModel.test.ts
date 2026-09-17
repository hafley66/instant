// The strip's own arithmetic: what the server's units become once the pane's row
// height is known, and what a turn's text looks like before it reaches a
// popover. Both are the client's only numbers — everything else is forwarded.
import { describe, expect, it } from "vitest"
import { SQUARE_STEP, type SquareKind } from "./0_agentSquareVisual"
import { previewOf, squaresOf } from "./1_agentSquaresModel"
import type { Strip, StripLayout, StripTurn } from "./1_agentSquaresFeed"

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

  it("centres a recent block on the track and steps it by SQUARE_STEP", () => {
    const turns = [
      turn("s1:1", "user", "the opening prompt", 1_699_999_000_000),
      turn("s1:2", "agent", "line one\nline two", 1_700_000_000_000),
      turn("s1:3", "agent", "and the reply", 1_700_000_100_000),
    ]
    const props = squaresOf(
      frame(
        {
          mode: "recent",
          rows: 24,
          squares: [
            { id: "s1:1", kind: "user", y: 0, scale: 1, active: false },
            { id: "s1:2", kind: "agent", y: 1, scale: 1, active: true },
            { id: "s1:3", kind: "agent", y: 2, scale: 1, active: false },
          ],
        },
        [],
        turns,
      ),
      { cellHeight: 17, track: 320 },
    )

    // The whole track *is* the recent strip's space: no rows of its own to
    // convert, and no band counted in.
    expect(props.track).toBe(320)
    expect(props.band).toBe(0)
    expect(props.active).toBe(1)
    const top = (320 - 3 * SQUARE_STEP) / 2
    expect(props.squares.map((square) => square.y)).toEqual([
      top,
      top + SQUARE_STEP,
      top + 2 * SQUARE_STEP,
    ])
    // Uniform: a recent square's size is never its turn's, and none is pinned.
    expect(props.squares.map((square) => square.scale)).toEqual([1, 1, 1])
    expect(props.squares.some((square) => square.pinned)).toBe(false)

    // A block taller than the track still starts at its top: the centring clamps
    // rather than pushing the oldest square off the strip.
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
