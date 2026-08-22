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
          "confidence": "anchored",
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

  it("selects the compact parent turn over an approval transcript containing the same response", () => {
    const response = [
      "Properties:",
      "- Every streamed write resets the quiet timer.",
      "- switchMap cancels the previous wait.",
      "- No polling.",
    ].join("\n");
    const parent = { ...turn(14, response), session: "parent", ts: 140 };
    const approval = {
      ...turn(80, [
        "Review the following proposed response:",
        "<assistant_response>",
        response,
        "</assistant_response>",
        "Return an approval decision.",
      ].join("\n")),
      session: "approval-child",
      ts: 150,
    };
    expect(locateVisibleTurns([
      { text: "Properties:", start: 70, end: 70 },
      { text: "- Every streamed write resets the quiet timer.", start: 71, end: 71 },
      { text: "- switchMap cancels the previous wait.", start: 72, end: 72 },
      { text: "- No polling.", start: 73, end: 73 },
    ], [approval, parent]).map(({ id, bufferStart, bufferEnd }) => ({ id, bufferStart, bufferEnd })))
      .toMatchInlineSnapshot(`
        [
          {
            "bufferEnd": 73,
            "bufferStart": 70,
            "id": "parent:14",
          },
        ]
      `);
  });

  it("normalizes unicode box-drawing characters in tables and borders to match markdown turns", () => {
    const tableScreen = [
      { text: "   Boop mechanism                       Common systems concept", start: 1, end: 1 },
      { text: "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", start: 2, end: 2 },
      { text: "   Inspecting WebSocket relay           Sidecar or transparent protocol proxy", start: 3, end: 3 },
      { text: "  ───────────────────────────────────  ──────────────────────────────────────────────────────", start: 4, end: 4 },
      { text: "   Unix domain sockets                  Local IPC used by editors, language servers, daemons", start: 5, end: 5 },
    ];
    const markdownTurn = turn(10135, [
      "| Boop mechanism | Common systems concept |",
      "|---|---|",
      "| Inspecting WebSocket relay | Sidecar or transparent protocol proxy |",
      "| Unix domain sockets | Local IPC used by editors, language servers, daemons |",
    ].join("\n"));

    expect(normalizeTurnLine(tableScreen[1].text)).toBe("");
    expect(normalizeTurnLine(tableScreen[2].text)).toBe("inspecting websocket relay sidecar or transparent protocol proxy");
    expect(locateVisibleTurns(tableScreen, [markdownTurn]).map(({ id, bufferStart, bufferEnd }) => ({ id, bufferStart, bufferEnd })))
      .toMatchInlineSnapshot(`
        [
          {
            "bufferEnd": 5,
            "bufferStart": 1,
            "id": "session-a:10135",
          },
        ]
      `);
  });
});
