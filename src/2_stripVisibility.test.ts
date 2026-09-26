import { expect, it } from "vitest"
import type { Strip, StripTurn } from "./1_agentSquaresFeed"
import { stripSpans } from "./2_stripVisibility"

const turn = (over: Partial<StripTurn>): StripTurn => ({
  session: "7ea906f3", harness: "claude", turn: 0, ts: 0, role: "assistant", said: "", id: "",
  buffer_start: 0, buffer_end: 0, anchor_start: 0, anchor_end: 0, confidence: "anchored", ...over,
})

it("places each pushed turn on the xterm rows the pane shows, and nothing for pinned or off-window turns", () => {
  // A 300-row capture; the pane shows capture rows 250..299 (50 rows, live bottom).
  // xterm's viewport starts at buffer row 1000.
  const frame: Strip = {
    pane: "%1",
    session: "7ea906f3", at: 0, rows: 300, tags: {}, layout: null,
    window: { top: 250, bottom: 299 },
    pinned: [turn({ turn: 500, role: "user", id: "7ea906f3:500", confidence: "pinned" })],
    turns: [
      turn({ turn: 510, id: "7ea906f3:510", buffer_start: 200, buffer_end: 240, anchor_start: 200, anchor_end: 240 }),
      turn({ turn: 514, role: "meta", id: "7ea906f3:514", buffer_start: 251, buffer_end: 257, anchor_start: 251, anchor_end: 257 }),
      turn({ turn: 516, id: "7ea906f3:516", buffer_start: 259, buffer_end: 263, anchor_start: 259, anchor_end: 262, confidence: "extended" }),
      turn({ turn: 519, role: "user", id: "7ea906f3:519", buffer_start: 281, buffer_end: 282, anchor_start: 281, anchor_end: 281, confidence: "extended" }),
    ],
  }
  expect(stripSpans(frame, 1000).map(({ id, role, bufferStart, bufferEnd, anchorStart, anchorEnd, confidence }) =>
    `${id} ${role} buffer ${bufferStart}..${bufferEnd} anchor ${anchorStart}..${anchorEnd} ${confidence}`)).toMatchInlineSnapshot(`
      [
        "7ea906f3:514 meta buffer 1001..1007 anchor 1001..1007 anchored",
        "7ea906f3:516 assistant buffer 1009..1013 anchor 1009..1012 extended",
        "7ea906f3:519 user buffer 1031..1032 anchor 1031..1031 extended",
      ]
    `)
})
