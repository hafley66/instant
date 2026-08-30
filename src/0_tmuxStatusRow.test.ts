import { describe, expect, it } from "vitest";
import { locateVisibleTurns, dropTmuxStatusRow } from "./0_terminalTurnVisibility";
import type { LogicalLine } from "./00a_terminalIntersection";
import type { BoopTurn } from "./0_terminalTurnVisibility";

const turn = (n: number, said: string): BoopTurn => ({
  session: "session-a",
  harness: "codex",
  turn: n,
  ts: n,
  role: "assistant",
  said,
});

/// A tmux pane occupies every xterm row but the last, which tmux paints its
/// status line on. `capture-pane` returns the pane and never the status line,
/// so the two readers disagree by exactly one row at the bottom.
const PANE: LogicalLine[] = [
  { text: "the assistant said something worth quoting", start: 40, end: 40 },
  { text: "and then said a second line of it", start: 41, end: 41 },
];
const STATUS: LogicalLine = { text: "kill-billionaires                 13:10", start: 42, end: 42 };
const CAPTURE = PANE.map((line) => line.text).join("\n");

describe("the tmux status row is not pane content", () => {
  it("is dropped when tmux's own capture does not contain it", () => {
    const kept = dropTmuxStatusRow([...PANE, STATUS], CAPTURE);
    expect(kept.map((line) => line.start)).toEqual([40, 41]);
  });

  it("keeps every row when tmux's capture covers the last one", () => {
    const lines = [...PANE];
    expect(dropTmuxStatusRow(lines, CAPTURE)).toBe(lines);
  });

  it("keeps every row when there is no tmux capture to compare against", () => {
    const lines = [...PANE, STATUS];
    expect(dropTmuxStatusRow(lines, "")).toBe(lines);
  });

  it("keeps a blank last row, which carries no text to disagree about", () => {
    const blank: LogicalLine = { text: "   ", start: 42, end: 42 };
    const lines = [...PANE, blank];
    expect(dropTmuxStatusRow(lines, CAPTURE)).toBe(lines);
  });

  // The defect: extendTo walks a span down to the first blank row, and the
  // status line is never blank, so the last turn on screen swallowed it and
  // every tag below the anchor sat one row lower than the text it named.
  it("stops the last turn's span at the pane's last row, not the status line", () => {
    const said = "the assistant said something worth quoting\nand then said a second line of it";
    // Receipt for the defect: handed the status row, the span swallows it.
    const withStatus = locateVisibleTurns([...PANE, STATUS], [turn(88, said)], CAPTURE);
    expect(withStatus[0]?.bufferEnd).toBe(42);

    const trimmed = dropTmuxStatusRow([...PANE, STATUS], CAPTURE);
    expect(locateVisibleTurns(trimmed, [turn(88, said)], CAPTURE)[0]?.bufferEnd).toBe(41);
  });
});
