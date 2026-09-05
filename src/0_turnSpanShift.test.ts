import { describe, it, expect } from "vitest";
import { shiftSpans, rowTags } from "./0_turnDebugOverlay";
import type { VisibleTurn } from "./0_terminalTurnVisibility";

const turn = (id: string, start: number, end: number): VisibleTurn => ({
  session: "s1",
  harness: "codex",
  turn: 7,
  ts: 1,
  role: "assistant",
  said: "hello",
  id,
  bufferStart: start,
  bufferEnd: end,
  anchorStart: start,
  anchorEnd: end,
  regions: [{
    id: `${id}:r0`,
    turnId: id,
    kind: "list",
    sourceStart: 0,
    sourceEnd: 1,
    bufferStart: start,
    bufferEnd: end,
  }] as VisibleTurn["regions"],
  confidence: "anchored",
  source: "xterm+boop",
});

// xterm trims the oldest scrollback line per line written once the buffer is
// full, so a projection taken before the write points one row too low.
describe("spans follow the buffer when scrollback trims", () => {
  it("moves every row of a span by the same shift", () => {
    const [moved] = shiftSpans([turn("a", 10, 14)], 1);
    expect([moved.bufferStart, moved.bufferEnd]).toEqual([9, 13]);
    expect([moved.anchorStart, moved.anchorEnd]).toEqual([9, 13]);
    expect([moved.regions[0].bufferStart, moved.regions[0].bufferEnd]).toEqual([9, 13]);
  });

  it("returns the same array when nothing moved", () => {
    const spans = [turn("a", 10, 14)];
    expect(shiftSpans(spans, 0)).toBe(spans);
  });

  it("puts the tag back on the row the text actually occupies", () => {
    const stale = [turn("a", 10, 12)];
    const before = rowTags(stale, 10, 3, null).map((tag) => tag.turnId);
    expect(before).toEqual(["a", "a", "a"]);
    // One line written: the text now lives at 9..11, and a projection still
    // reporting 10..12 would leave row 9 unlabelled and label row 12 wrongly.
    const after = rowTags(shiftSpans(stale, 1), 9, 4, null).map((tag) => tag.turnId);
    expect(after).toEqual(["a", "a", "a", null]);
  });

  it("carries a negative shift too, for a buffer that grew without trimming", () => {
    const [moved] = shiftSpans([turn("a", 10, 14)], -2);
    expect([moved.bufferStart, moved.bufferEnd]).toEqual([12, 16]);
  });
});
