import { describe, expect, it } from "vitest";
import { rowTags, turnHue } from "./0_turnDebugOverlay";
import type { VisibleTurn } from "./0_terminalTurnVisibility";

const visibleTurn = (
  turn: number,
  bufferStart: number,
  bufferEnd: number,
  overrides: Partial<VisibleTurn> = {},
): VisibleTurn => ({
  session: "session-a",
  harness: "codex",
  turn,
  ts: turn,
  role: "assistant",
  said: `turn ${turn}`,
  id: `session-a:${turn}`,
  bufferStart,
  bufferEnd,
  anchorStart: bufferStart,
  anchorEnd: bufferEnd,
  regions: [],
  confidence: "anchored",
  source: "xterm+boop",
  ...overrides,
});

describe("turn debug overlay row tags", () => {
  it("tags each row with its turn, role, confidence and span edge", () => {
    const tags = rowTags([
      visibleTurn(564, 10, 11),
      visibleTurn(565, 13, 13, { role: "user", confidence: "extended" }),
    ], 10, 5, null);
    expect(tags.map((tag) => tag.label)).toEqual([
      "┌ t564 assistant A",
      "└ t564 assistant A",
      "·",
      "◆ t565 user E",
      "·",
    ]);
    expect(tags.map((tag) => tag.bufferRow)).toEqual([10, 11, 12, 13, 14]);
    expect(tags.map((tag) => tag.viewportRow)).toEqual([0, 1, 2, 3, 4]);
    expect(tags.map((tag) => tag.turnId)).toEqual([
      "session-a:564", "session-a:564", null, "session-a:565", null,
    ]);
  });

  it("marks the first and last row of each turn span", () => {
    const tags = rowTags([visibleTurn(564, 10, 12)], 10, 4, null);
    expect(tags.map((tag) => [tag.spanStart, tag.spanEnd])).toEqual([
      [true, false], [false, false], [false, true], [false, false],
    ]);
  });

  it("marks a turn continuing through both viewport edges", () => {
    const tags = rowTags([
      visibleTurn(16, 20, 22, { clippedAbove: true, clippedBelow: true }),
    ], 20, 3, null);
    expect(tags.map((tag) => tag.label)).toEqual([
      "↑ t16 assistant A",
      "│ t16 assistant A",
      "↓ t16 assistant A",
    ]);
  });

  it("leaves a row outside every turn unattributed and uncoloured", () => {
    const [tag] = rowTags([visibleTurn(564, 20, 21)], 40, 1, null);
    expect(tag).toMatchObject({
      bufferRow: 40,
      turnId: null,
      turn: null,
      role: "",
      confidence: null,
      label: "·",
      hue: 0,
      spanStart: false,
      spanEnd: false,
      regionKind: null,
      pointer: false,
    });
  });

  it("carries the region kind on rows inside a projected region", () => {
    const turn = visibleTurn(564, 10, 14, {
      regions: [{
        kind: "table",
        sourceStart: 0,
        sourceEnd: 1,
        text: "| a |\n|---|",
        id: "session-a:564:table:0",
        turnId: "session-a:564",
        bufferStart: 12,
        bufferEnd: 13,
      }],
    });
    expect(rowTags([turn], 10, 5, null).map((tag) => tag.regionKind))
      .toEqual([null, null, "table", "table", null]);
  });

  it("flags exactly the pointer row", () => {
    const tags = rowTags([visibleTurn(564, 10, 12)], 10, 4, 11);
    expect(tags.map((tag) => tag.pointer)).toEqual([false, true, false, false]);
    expect(rowTags([visibleTurn(564, 10, 12)], 10, 4, null).some((tag) => tag.pointer)).toBe(false);
    expect(rowTags([visibleTurn(564, 10, 12)], 10, 4, 99).some((tag) => tag.pointer)).toBe(false);
  });

  it("retargets a fixed pointer row when the projection owner changes", () => {
    const before = rowTags([
      visibleTurn(22, 40, 42, { role: "user" }),
    ], 40, 3, 41)[1];
    const after = rowTags([
      visibleTurn(23, 41, 43, { role: "assistant" }),
    ], 40, 3, 41)[1];
    expect({
      before: { pointer: before.pointer, label: before.label, turnId: before.turnId },
      after: { pointer: after.pointer, label: after.label, turnId: after.turnId },
    }).toMatchInlineSnapshot(`
      {
        "after": {
          "label": "┌ t23 assistant A",
          "pointer": true,
          "turnId": "session-a:23",
        },
        "before": {
          "label": "│ t22 user A",
          "pointer": true,
          "turnId": "session-a:22",
        },
      }
    `);
  });

  it("gives one turn id one stable hue in range and separates neighbouring turns", () => {
    expect(turnHue("session-a:564")).toBe(turnHue("session-a:564"));
    expect(turnHue("session-a:564")).toBeGreaterThanOrEqual(0);
    expect(turnHue("session-a:564")).toBeLessThan(360);
    expect(turnHue("session-a:564")).not.toBe(turnHue("session-a:565"));
  });
});
