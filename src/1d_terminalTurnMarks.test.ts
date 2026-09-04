import { describe, expect, it } from "vitest";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import type { BoopTurnComment } from "./1b_terminalContextSync";
import { markRowFor, markTitle, placeAnnotations } from "./1d_terminalTurnMarks";

const line = (id: string, row: number, text: string): VisibleTerminalLine =>
  ({ id, bufferStart: row, bufferEnd: row, viewportStart: row, viewportEnd: row, text });

const turn = (id: string, start: number, end: number): VisibleTurn => ({
  id, bufferStart: start, bufferEnd: end, anchorStart: start, anchorEnd: end,
  regions: [], confidence: "anchored", source: "xterm+boop",
} as unknown as VisibleTurn);

const comment = (over: Partial<BoopTurnComment> = {}): BoopTurnComment => ({
  clientId: "selection:1:0",
  kind: "selection",
  quote: "DBSP.State.Retain",
  note: "bad name",
  enabled: true,
  tabName: "sprefa-2",
  targets: [{ session: "sess-a", turn: 3080, role: "assistant", replyTurn: 3083 }],
  createdTs: 0,
  updatedTs: 0,
  ...over,
});

describe("sent comments painted back onto their turns", () => {
  const lines = [
    line("l1", 20, "  - DBSP.State.Integrate"),
    line("l2", 21, "  - DBSP.State.Retain"),
    line("l3", 22, "  - DBSP.Event.Arrival"),
  ];

  it("lands on the row whose text carries the quote", () => {
    expect(markRowFor(comment(), turn("sess-a:3080", 20, 22), lines)).toBe(21);
  });

  it("falls back to the turn's first visible row when the quote is off screen", () => {
    expect(markRowFor(comment({ quote: "scrolled away" }), turn("sess-a:3080", 20, 22), lines)).toBe(20);
    expect(markRowFor(comment(), turn("sess-a:3080", 40, 42), lines)).toBeNull();
  });

  it("places only comments whose target turn is on screen", () => {
    const placed = placeAnnotations(
      [comment(), comment({ clientId: "selection:2:0", targets: [{ session: "sess-a", turn: 99, role: "" }] })],
      [turn("sess-a:3080", 20, 22)],
      lines,
    );
    expect(placed.map((entry) => [entry.comment.clientId, entry.bufferRow])).toEqual([["selection:1:0", 21]]);
  });

  it("titles a mark with the note, the quote, and the reply turn", () => {
    const placed = placeAnnotations([comment()], [turn("sess-a:3080", 20, 22)], lines);
    expect(markTitle(placed)).toBe("bad name\n> DBSP.State.Retain\nreply: turn 3083");
    const pending = placeAnnotations(
      [comment({ note: null, targets: [{ session: "sess-a", turn: 3080, role: "" }] })],
      [turn("sess-a:3080", 20, 22)],
      lines,
    );
    expect(markTitle(pending)).toBe("(no note)\n> DBSP.State.Retain\nreply: not ingested yet");
  });
});
