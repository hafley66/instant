// The strip's own arithmetic: what the server's units become once the pane's row
// height is known, and what a turn's text looks like before it reaches a
// popover. Both are the client's only numbers — everything else is forwarded.
import { describe, expect, it } from "vitest"
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

const frame = (layout: StripLayout, pinned: StripTurn[] = []): Strip => ({
  session: "s1",
  at: 1_700_000_000_000,
  rows: 40,
  turns: [
    turn("s1:2", "assistant", "line one\nline two", 1_700_000_000_000),
    turn("s1:3", "tool", "sqlite3 --version", 1_700_000_100_000),
  ],
  pinned,
  tags: {},
  layout,
})

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
        "block": null,
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
  })

  it("spreads a map over its track and keeps the block visible", () => {
    const props = squaresOf(
      frame({
        mode: "map",
        band: 0,
        span: 100,
        block: { top: 20, height: 10 },
        squares: [{ id: "s1:2", kind: "agent", y: 30, scale: 1, active: true }],
      }),
      { cellHeight: 17, track: 320 },
    )
    expect(props).toMatchInlineSnapshot(`
      {
        "active": 0,
        "band": 0,
        "block": {
          "height": 32,
          "top": 64,
        },
        "squares": [
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
            "scale": 1,
            "turn": 2,
            "y": 96,
          },
        ],
        "track": 320,
      }
    `)

    // A window that is a sliver of a long map still draws: a hairline block is
    // one the reader cannot find.
    const sliver = squaresOf(
      frame({
        mode: "map",
        band: 0,
        span: 1000,
        block: { top: 900, height: 1 },
        squares: [],
      }),
      { cellHeight: 17, track: 320 },
    )
    expect(sliver.block).toMatchInlineSnapshot(`
      {
        "height": 6,
        "top": 288,
      }
    `)
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
