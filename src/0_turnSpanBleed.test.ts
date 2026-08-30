import { describe, it, expect } from "vitest";
import { locateVisibleTurns, normalizeTurnLine } from "./0_terminalTurnVisibility";
import type { LogicalLine } from "./00a_terminalIntersection";

const screenOf = (rows: string[], from = 0): LogicalLine[] =>
  rows.map((text, index) => ({ text, start: from + index, end: from + index }));

const boopTurn = (turn: number, said: string) => ({
  session: "s1",
  harness: "codex",
  turn,
  ts: 1000 + turn,
  role: "assistant",
  said,
});

// Two assistant messages on screen, only the first one present in boop. The
// greedy fill used to hand every row to that one turn, so the debug overlay
// labelled both messages with a single turn id.
describe("a matched turn does not swallow the message below it", () => {
  const rows = [
    "first message line one",
    "first message line two",
    "",
    "second message line one",
    "second message line two",
  ];

  it("stops at the blank row when the neighbour is unmatched", () => {
    const visible = locateVisibleTurns(screenOf(rows), [boopTurn(1, "first message line one\nfirst message line two")]);
    expect(visible).toHaveLength(1);
    expect(visible[0].bufferStart).toBe(0);
    expect(visible[0].bufferEnd).toBe(1);
  });

  it("leaves the second message attributed to nothing", () => {
    const visible = locateVisibleTurns(screenOf(rows), [boopTurn(1, "first message line one\nfirst message line two")]);
    const owner = (row: number) =>
      visible.find((turn) => turn.bufferStart <= row && row <= turn.bufferEnd)?.turn ?? null;
    expect([owner(0), owner(1), owner(2), owner(3), owner(4)]).toEqual([1, 1, null, null, null]);
  });

  it("still gives each turn its own block when both are present", () => {
    const visible = locateVisibleTurns(screenOf(rows), [
      boopTurn(1, "first message line one\nfirst message line two"),
      boopTurn(2, "second message line one\nsecond message line two"),
    ]);
    expect(visible.map((turn) => [turn.turn, turn.bufferStart, turn.bufferEnd])).toEqual([
      [1, 0, 1],
      [2, 3, 4],
    ]);
  });

  it("treats a whitespace-only row as blank", () => {
    expect(normalizeTurnLine("   ")).toBe("");
  });
});
