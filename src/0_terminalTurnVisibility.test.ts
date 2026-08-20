import { describe, expect, it } from "vitest";
import { locateVisibleTurns, normalizeTurnLine, type BoopTurn } from "./0_terminalTurnVisibility";

const turn = (turn: number, said: string): BoopTurn => ({
  session: "session-a", harness: "codex", turn, ts: turn, role: "assistant", said,
});

describe("terminal turn visibility v2", () => {
  it("normalizes terminal chrome and locates unique Boop turns", () => {
    const rows = [
      { text: "⏺ Alpha response with a stable phrase", start: 40, end: 40 },
      { text: "  shared trailing sentence", start: 41, end: 41 },
      { text: "› Beta request with another stable phrase", start: 42, end: 43 },
    ];
    expect(normalizeTurnLine(rows[0].text)).toBe("alpha response with a stable phrase");
    expect(locateVisibleTurns(rows, [
      turn(7, "Alpha response with a stable phrase\nshared trailing sentence"),
      turn(8, "Beta request with another stable phrase\nshared trailing sentence"),
    ])).toMatchInlineSnapshot(`
      [
        {
          "bufferEnd": 41,
          "bufferStart": 40,
          "confidence": "extended",
          "harness": "codex",
          "id": "session-a:7",
          "provenance": "xterm+boop",
          "regions": [],
          "role": "assistant",
          "said": "Alpha response with a stable phrase
      shared trailing sentence",
          "session": "session-a",
          "ts": 7,
          "turn": 7,
        },
        {
          "bufferEnd": 43,
          "bufferStart": 42,
          "confidence": "anchored",
          "harness": "codex",
          "id": "session-a:8",
          "provenance": "xterm+boop",
          "regions": [],
          "role": "assistant",
          "said": "Beta request with another stable phrase
      shared trailing sentence",
          "session": "session-a",
          "ts": 8,
          "turn": 8,
        },
      ]
    `);
  });

  it("keeps multiline source and wrapped xterm rows under one turn identity", () => {
    expect(locateVisibleTurns([
      { text: "first source line", start: 10, end: 10 },
      { text: "one long logical source line wrapped by xterm", start: 11, end: 13 },
      { text: "last source line", start: 14, end: 14 },
    ], [turn(9, [
      "first source line",
      "one long logical source line wrapped by xterm",
      "last source line",
    ].join("\n"))])).toMatchInlineSnapshot(`
      [
        {
          "bufferEnd": 14,
          "bufferStart": 10,
          "confidence": "anchored",
          "harness": "codex",
          "id": "session-a:9",
          "provenance": "xterm+boop",
          "regions": [],
          "role": "assistant",
          "said": "first source line
      one long logical source line wrapped by xterm
      last source line",
          "session": "session-a",
          "ts": 9,
          "turn": 9,
        },
      ]
    `);
  });
});
