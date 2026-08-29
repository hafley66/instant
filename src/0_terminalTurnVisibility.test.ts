import { describe, expect, it, vi } from "vitest";
import { EMPTY } from "rxjs";
import {
  locateVisibleTurns,
  normalizeTurnLine,
  TerminalTurnVisibilityV2,
  type BoopTurn,
} from "./0_terminalTurnVisibility";
import type { LogicalLine, XtermViewport } from "./00a_terminalIntersection";

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
          "anchorEnd": 41,
          "anchorStart": 40,
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
          "anchorEnd": 43,
          "anchorStart": 42,
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
          "anchorEnd": 14,
          "anchorStart": 10,
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

  // Defect receipt 2026-08-22: right-click inside a long assistant report
  // resolved to the previous user turn. Every report line carried inline code
  // beside punctuation ("(`5a38640`)"); spacing the backticks out produced
  // "( 5a38640 )", which never matched the rendered "(5a38640)", so the turn
  // had no anchor and the user turn's extended span swallowed it.
  it("matches inline code and bold beside punctuation the way the pane renders them", () => {
    const said = [
      "**instant: turn-visibility scan cost** (instant `51c9a89` + hafley-rs `8bb7dc9`)",
      "",
      "Receipts: instant PID 80115 rebuilt by `tauri dev`, 6 one-second samples `0.0 3.1` %CPU.",
    ].join("\n");
    expect(normalizeTurnLine("instant: turn-visibility scan cost (instant 51c9a89 + hafley-rs 8bb7dc9)"))
      .toBe(normalizeTurnLine(said.split("\n")[0]));
    const rows = [
      { text: "› yes get it fixed with receipts", start: 10, end: 10 },
      { text: "", start: 11, end: 11 },
      { text: "instant: turn-visibility scan cost (instant 51c9a89 + hafley-rs 8bb7dc9)", start: 12, end: 12 },
      { text: "", start: 13, end: 13 },
      { text: "Receipts: instant PID 80115 rebuilt by tauri dev, 6 one-second samples 0.0 3.1 %CPU.", start: 14, end: 14 },
    ];
    const turns = [
      { ...turn(160, "yes get it fixed with receipts"), role: "user" },
      turn(192, said),
    ];
    const visible = locateVisibleTurns(rows, turns);
    const at = (row: number) => visible.find((v) => v.bufferStart <= row && row <= v.bufferEnd)?.turn;
    expect(at(10)).toBe(160);
    expect(at(12)).toBe(192);
    expect(at(14)).toBe(192);
    const identity = (row: number) => visible.find((v) => v.anchorStart <= row && row <= v.anchorEnd)?.turn ?? null;
    expect(identity(10)).toBe(160);
    expect(identity(12)).toBe(192);
    expect(identity(14)).toBe(192);
    expect(identity(11)).toBeNull();
    expect(identity(13)).toBe(192);
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

  // Defect receipt 2026-08-29 (lab-claude, lab-ccz): the separator class held
  // the horizontal rules but never the vertical Claude Code puts between cells,
  // so every table data row failed to match and the turn anchored on prose only.
  it("matches a rendered table's data rows through the vertical cell separator", () => {
    const screen = [
      { text: "  ┌─────────┬────────────┐", start: 4, end: 4 },
      { text: "  │ fixture │    tmux    │", start: 5, end: 5 },
      { text: "  ├─────────┼────────────┤", start: 6, end: 6 },
      { text: "  │ claude  │ lab-claude │", start: 7, end: 7 },
      { text: "  └─────────┴────────────┘", start: 8, end: 8 },
    ];
    expect(normalizeTurnLine(screen[1].text)).toBe("fixture tmux");
    expect(normalizeTurnLine(screen[0].text)).toBe("");
    const source = turn(41, ["| fixture | tmux |", "| --- | --- |", "| claude | lab-claude |"].join("\n"));
    const [located] = locateVisibleTurns(screen, [source]);
    expect(located.anchorStart).toBe(5);
    expect(located.anchorEnd).toBe(7);
  });

  // Defect receipt 2026-08-29 (lab-claude at 80 cols): the monotonic match is
  // 1:1, so one source line an app hard-wraps across three rows anchored one.
  it("anchors every row an app hard-wraps out of a single source line", () => {
    const said = "markdown tables in claude code get responsive designed into a list mode "
      + "so there are two renders for it, and code and tool calls";
    const screen = [
      { text: "  unrelated banner line", start: 20, end: 20 },
      { text: "  markdown tables in claude code get responsive designed into", start: 21, end: 21 },
      { text: "  a list mode so there are two renders for it, and code and", start: 22, end: 22 },
      { text: "  tool calls", start: 23, end: 23 },
    ];
    const [located] = locateVisibleTurns(screen, [turn(58, said)]);
    expect(located.anchorStart).toBe(21);
    // Row 23 normalizes to "tool calls", under the 12-character floor a
    // containment match needs, so a short trailing fragment stays unanchored.
    expect(located.anchorEnd).toBe(22);
    expect(normalizeTurnLine(screen[3].text).length).toBeLessThan(12);
  });

  // Defect receipt 2026-08-29 (lab-kimi): kimi prefixes a user message with ✨,
  // and Claude Code uses ✻ and ⎿; none were in the leading-marker class, so an
  // otherwise exact line missed by one glyph.
  it("strips the per-harness message markers kimi and claude code print", () => {
    const said = "i guess lab it out with joernn and then see if rust can go faster";
    for (const marker of ["✨", "✻", "⎿", "⏺"]) {
      expect(normalizeTurnLine(`${marker} ${said}`)).toBe(said);
    }
    const screen = [{ text: `✨ ${said}`, start: 8, end: 8 }];
    const [located] = locateVisibleTurns(screen, [turn(507, said)]);
    expect(located.turn).toBe(507);
    expect(located.anchorStart).toBe(8);
  });

  // Defect receipt 2026-08-29 (lab-kimi): a skill-instruction turn claimed eight
  // rows of an unrelated diff because one short line of its body appeared inside
  // them, so containment now has to cover half the longer string.
  it("refuses a short source line found inside a much longer rendered row", () => {
    const screen = [
      { text: "  3 + head-to-head framing from 2026-07-25: run joern first as the reference, then the rust lab as challenger", start: 19, end: 19 },
      { text: "  4 + soufflé and kuzu become optional fillers only when the head-to-head stays inconclusive after both runs", start: 20, end: 20 },
    ];
    const skill = turn(481, ["Skill tool loaded instructions for this request.", "run joern", "## Naming"].join("\n"));
    expect(locateVisibleTurns(screen, [skill])).toEqual([]);
  });

  // Defect receipt 2026-08-29: the right-click menu reads turnAtClientPoint,
  // which reads turnAtBufferRow. Every other test asserts the located spans
  // directly, so the accessor itself needs one that drives the real class.
  it("answers turnAtBufferRow from the anchor and stays silent off it", async () => {
    const lines: LogicalLine[] = [
      { text: "terminal chrome above the turn", start: 40, end: 40 },
      { text: "the assistant said something worth quoting", start: 41, end: 41 },
      { text: "and then said a second line of it", start: 42, end: 42 },
      { text: "ask codex to do anything", start: 43, end: 43 },
    ];
    const viewport: XtermViewport = {
      changes: EMPTY,
      readVisibleLogicalLines: () => lines,
      bufferRowAtClientY: (clientY: number) => 40 + clientY,
      dispose: () => {},
    };
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const said = "the assistant said something worth quoting\nand then said a second line of it";
    const visibility = new TerminalTurnVisibilityV2(viewport, async () => []);
    await visibility.scan([turn(88, said)]);

    expect(visibility.turnAtBufferRow(41)?.turn).toBe(88);
    expect(visibility.turnAtBufferRow(42)?.turn).toBe(88);
    expect(visibility.turnAtBufferRow(40)).toBeNull();
    expect(visibility.turnAtBufferRow(43)).toBeNull();
    expect(visibility.turnAtClientPoint(0, 1)?.turn).toBe(88);
    expect(visibility.turnAtClientPoint(0, 3)).toBeNull();
    visibility.dispose();
    vi.unstubAllGlobals();
  });

  // boop-turnvis answers over IPC in the app. Two things must hold: its spans
  // are used verbatim, and a failed call still leaves the pane readable.
  it("prefers the injected locator and falls back to the local matcher when it rejects", async () => {
    const lines: LogicalLine[] = [
      { text: "the assistant said something worth quoting", start: 41, end: 41 },
      { text: "and then said a second line of it", start: 42, end: 42 },
    ];
    const viewport: XtermViewport = {
      changes: EMPTY,
      readVisibleLogicalLines: () => lines,
      bufferRowAtClientY: () => null,
      dispose: () => {},
    };
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const said = "the assistant said something worth quoting\nand then said a second line of it";
    const boopTurn = turn(88, said);
    const span = {
      ...boopTurn,
      id: `${boopTurn.session}:88`,
      bufferStart: 41,
      bufferEnd: 42,
      anchorStart: 41,
      anchorEnd: 41,
      confidence: "anchored" as const,
    };

    const native = new TerminalTurnVisibilityV2(viewport, async () => [], undefined, async () => [span]);
    await native.scan([boopTurn]);
    // anchorEnd 41 is the native answer; the local matcher would say 42.
    expect(native.visible.map((found) => [found.turn, found.anchorStart, found.anchorEnd])).toEqual([[88, 41, 41]]);
    expect(native.visible[0].regions).toBeDefined();
    expect(native.turnAtBufferRow(42)).toBeNull();
    native.dispose();

    const failing = new TerminalTurnVisibilityV2(viewport, async () => [], undefined, () => Promise.reject(new Error("ipc down")));
    await failing.scan([boopTurn]);
    expect(failing.visible.map((found) => [found.turn, found.anchorStart, found.anchorEnd])).toEqual([[88, 41, 42]]);
    failing.dispose();
    vi.unstubAllGlobals();
  });
});
