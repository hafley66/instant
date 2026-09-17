// The boundary, mocked: this is what the turn-attribution process hands the
// strip, and nothing more.
//
//   grid rows + `BoopTurn[]`  ->  `VisibleTurn[]`  ->  this file
//   xterm + tmux + boop            matcher             the estimator
//
// `VisibleTurn` carries the span the matcher found (`bufferStart`/`bufferEnd`),
// the row each source line landed on (`regions[].sourceBufferRows`), and the
// turn's own text (`said`). The span says how many rows the turn owns; the row
// mapping says how many of its lines are inside the viewport; `said`'s own
// newline count is the turn's size in the rolling window. No query, no store,
// no second IPC call — the estimator works off these three facts alone.
import { describe, expect, it } from "vitest"
import type { VisibleTurn } from "./0_terminalTurnVisibility"
import {
  measure,
  placeWindow,
  samplesFrom,
  stripLayout,
  windowOf,
  STRIP_DEFAULTS,
  type RowWindow,
} from "./1_agentSquaresEstimate"

const said = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")

/** One projection row and the buffer rows its lines landed on. */
type TurnSpec = { id: string; role: string; span: [number, number]; lines: number; rows: number[] }

const paneOf = (specs: TurnSpec[]): VisibleTurn[] =>
  specs.map((spec, index) => ({
    id: spec.id,
    session: "s1",
    harness: "claude",
    turn: index + 1,
    ts: 1_700_000_000_000 + index,
    role: spec.role,
    said: said(spec.lines),
    bufferStart: spec.span[0],
    bufferEnd: spec.span[1],
    anchorStart: spec.span[0],
    anchorEnd: spec.span[1],
    regions: [
      {
        kind: "list" as const,
        sourceStart: 0,
        sourceEnd: spec.lines,
        text: "",
        id: `${spec.id}:r0`,
        turnId: spec.id,
        bufferStart: spec.span[0],
        bufferEnd: spec.span[1],
        sourceBufferRows: spec.rows,
      },
    ],
    confidence: "anchored" as const,
    source: "xterm+boop" as const,
  }))

// A claude pane mid-stream: a one-line prompt, a long answer that wraps, a SQL
// result, a short answer, a short tool result. Rows 2, 31-32, 51 and 59-60 hold
// nothing the matcher attributed — blank lines and the result's own separator.
const pane = paneOf([
  { id: "u1", role: "user", span: [0, 1], lines: 1, rows: [0] },
  { id: "a2", role: "assistant", span: [3, 30], lines: 24, rows: [3, 5, 7, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] },
  { id: "t3", role: "tool", span: [33, 50], lines: 12, rows: [33, 35, 37, 39, 41, 43, 45, 46, 47, 48, 49, 50] },
  { id: "a4", role: "assistant", span: [52, 58], lines: 6, rows: [52, 54, 55, 56, 57, 58] },
  { id: "t5", role: "tool", span: [61, 63], lines: 2, rows: [61, 63] },
])

// The reader has scrolled so the SQL result's tail and the short answer are on
// screen: 24 rows, of which t3 shows 10 of its 12 lines and a4 all 6 of its.
const viewport: RowWindow = { top: 37, bottom: 60 }

const at = (value: number) => Number(value.toFixed(2))

describe("placing squares nobody has measured", () => {
  it("reads the viewport the way the matcher reported it", () => {
    expect(samplesFrom(pane, viewport)).toMatchInlineSnapshot(`
      [
        {
          "end": 50,
          "id": "t3",
          "kind": "tool",
          "lines": 10,
          "start": 37,
          "total": 12,
          "turnStart": 33,
        },
        {
          "end": 58,
          "id": "a4",
          "kind": "agent",
          "lines": 6,
          "start": 52,
          "total": 6,
          "turnStart": 52,
        },
      ]
    `)
  })

  it("measures wrap and gap overhead from what is on screen", () => {
    expect(measure(samplesFrom(pane, viewport), viewport)).toMatchInlineSnapshot(`
      {
        "gamma": {
          "agent": 1,
          "other": 1,
          "tool": 1,
          "user": 1,
        },
        "kappa": {
          "agent": 1.1666666666666667,
          "other": 1.3125,
          "tool": 1.4,
          "user": 1.3125,
        },
        "kappaMax": 1.4,
      }
    `)
  })

  it("places every turn in the window when only two of them are visible", () => {
    const samples = samplesFrom(pane, viewport)
    expect(placeWindow(windowOf(pane), samples, measure(samples, viewport), viewport)).toMatchInlineSnapshot(`
      [
        {
          "id": "u1",
          "kind": "user",
          "measured": false,
          "rows": 1.3125,
          "seen": 1,
          "start": 1.6875,
          "total": 1,
        },
        {
          "id": "a2",
          "kind": "agent",
          "measured": false,
          "rows": 28,
          "seen": 1,
          "start": 4,
          "total": 24,
        },
        {
          "id": "t3",
          "kind": "tool",
          "measured": true,
          "rows": 16.8,
          "seen": 0.8333333333333334,
          "start": 33,
          "total": 12,
        },
        {
          "id": "a4",
          "kind": "agent",
          "measured": true,
          "rows": 7,
          "seen": 1,
          "start": 52,
          "total": 6,
        },
        {
          "id": "t5",
          "kind": "tool",
          "measured": false,
          "rows": 2.8,
          "seen": 1,
          "start": 60,
          "total": 2,
        },
      ]
    `)
  })

  it("keeps the measured turns at their own rows and stacks the rest around them", () => {
    const samples = samplesFrom(pane, viewport)
    const placements = placeWindow(windowOf(pane), samples, measure(samples, viewport), viewport)
    for (const placement of placements) {
      if (!placement.measured) continue
      const turn = pane.find((candidate) => candidate.id === placement.id)
      expect(placement.start).toBe(turn?.bufferStart)
    }
    expect(at(placements[4].start)).toBe(at(placements[3].start + placements[3].rows + 1))
  })

  it("lays the strip out: one height, a clamped scale, and the block the reader is in", () => {
    const samples = samplesFrom(pane, viewport)
    const placements = placeWindow(windowOf(pane), samples, measure(samples, viewport), viewport)
    const strip = stripLayout(placements, 40, viewport)
    expect({ span: at(strip.span), block: { top: at(strip.block.top), height: at(strip.block.height) }, squares: strip.squares.map((square) => ({ ...square, y: at(square.y), scale: at(square.scale) })) }).toMatchInlineSnapshot(`
      {
        "block": {
          "height": 115.7,
          "top": 185.29,
        },
        "span": 55.91,
        "squares": [
          {
            "active": false,
            "id": "u1",
            "scale": 0.71,
            "y": 0,
          },
          {
            "active": false,
            "id": "a2",
            "scale": 1.9,
            "y": 7.3,
          },
          {
            "active": true,
            "id": "t3",
            "scale": 1.35,
            "y": 163.04,
          },
          {
            "active": false,
            "id": "a4",
            "scale": 1,
            "y": 256.49,
          },
          {
            "active": false,
            "id": "t5",
            "scale": 0.77,
            "y": 295.43,
          },
        ],
      }
    `)
  })

  it("marks the square the reader is looking at, and the ends when nothing is", () => {
    const samples = samplesFrom(pane, viewport)
    const placements = placeWindow(windowOf(pane), samples, measure(samples, viewport), viewport)
    const active = (row: number | null) => stripLayout(placements, row, viewport).squares.findIndex((square) => square.active)
    expect([active(40), active(56), active(0), active(999), active(null)]).toEqual([2, 3, 0, 4, 4])
  })

  it("slides the block down as the reader scrolls, and keeps it visible at both ends", () => {
    const samples = samplesFrom(pane, viewport)
    const placements = placeWindow(windowOf(pane), samples, measure(samples, viewport), viewport)
    const blockAt = (top: number) => stripLayout(placements, top, { top, bottom: top + 23 }).block
    const blocks = [blockAt(0), blockAt(20), blockAt(40), blockAt(60)].map((block) => ({ top: at(block.top), height: at(block.height) }))
    expect(blocks).toMatchInlineSnapshot(`
      [
        {
          "height": 118.55,
          "top": 0,
        },
        {
          "height": 127.93,
          "top": 96.3,
        },
        {
          "height": 109.02,
          "top": 201.98,
        },
        {
          "height": 15.57,
          "top": 295.43,
        },
      ]
    `)
    expect(blocks.map((block) => block.top)).toEqual([...blocks.map((block) => block.top)].sort((a, b) => a - b))
    expect(Math.min(...blocks.map((block) => block.height))).toBeGreaterThanOrEqual(STRIP_DEFAULTS.blockMin)
  })

  it("fits a turn the matcher dropped into the gap its neighbours left", () => {
    const gap = paneOf([
      { id: "x1", role: "assistant", span: [0, 9], lines: 5, rows: [0, 2, 4, 6, 8] },
      { id: "x3", role: "assistant", span: [23, 32], lines: 4, rows: [23, 25, 27, 29] },
    ])
    const all = paneOf([
      { id: "x1", role: "assistant", span: [0, 9], lines: 5, rows: [0, 2, 4, 6, 8] },
      { id: "x2", role: "tool", span: [12, 20], lines: 3, rows: [12, 15, 18] },
      { id: "x3", role: "assistant", span: [23, 32], lines: 4, rows: [23, 25, 27, 29] },
    ])
    const whole: RowWindow = { top: 0, bottom: 32 }
    const samples = samplesFrom(gap, whole)
    const placements = placeWindow(windowOf(all), samples, measure(samples, whole), whole)
    expect(placements.map((placement) => ({ id: placement.id, start: at(placement.start), rows: at(placement.rows), measured: placement.measured }))).toMatchInlineSnapshot(`
      [
        {
          "id": "x1",
          "measured": true,
          "rows": 10,
          "start": 0,
        },
        {
          "id": "x2",
          "measured": false,
          "rows": 6.67,
          "start": 13.17,
        },
        {
          "id": "x3",
          "measured": true,
          "rows": 10,
          "start": 23,
        },
      ]
    `)
  })

  it("costs microseconds per update, where a query per square costs a process", () => {
    const samples = samplesFrom(pane, viewport)
    const estimates = measure(samples, viewport)
    const window = windowOf(pane)
    const started = performance.now()
    for (let index = 0; index < 20_000; index += 1) {
      stripLayout(placeWindow(window, samples, estimates, viewport), 40 + (index % 20), viewport)
    }
    const perScroll = (performance.now() - started) / 20_000
    console.log(`estimate: ${(perScroll * 1000).toFixed(1)} µs per scroll frame, ${window.length} squares`)
    expect(perScroll).toBeLessThan(5)
  })
})
