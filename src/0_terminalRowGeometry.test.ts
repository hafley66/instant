import { describe, expect, it } from "vitest";
import type { IMarker } from "@xterm/xterm";
import {
  bufferRowAtClientY,
  gutterLeft,
  rowOnScreen,
  rowTop,
  shiftSpans,
  TerminalScanShift,
  type TerminalRowGeometry,
} from "./0_terminalRowGeometry";
import type { VisibleTurn } from "./0_terminalTurnVisibility";

const geometry: TerminalRowGeometry = {
  viewportY: 40,
  rows: 24,
  cellHeight: 15,
  top: 4,
  left: 60,
  right: 12,
  screen: { top: 100, bottom: 460, left: 60, right: 700, height: 360 },
};

describe("a buffer row's place on screen", () => {
  it("puts the first viewport row at the grid's own top", () => {
    expect(rowTop(geometry, 40)).toBe(4);
    expect(rowTop(geometry, 43)).toBe(49);
  });

  it("answers for a row above or below the viewport too, so a box can hide", () => {
    expect(rowTop(geometry, 38)).toBe(-26);
    expect(rowOnScreen(geometry, 39)).toBe(false);
    expect(rowOnScreen(geometry, 40)).toBe(true);
    expect(rowOnScreen(geometry, 63)).toBe(true);
    expect(rowOnScreen(geometry, 64)).toBe(false);
  });

  it("parks the gutter left of the grid, and never off the host edge", () => {
    expect(gutterLeft(geometry, 42)).toBe(18);
    expect(gutterLeft(geometry, 200)).toBe(2);
  });
});

describe("the buffer row under a pointer", () => {
  it("reads the row off the cell height, not off a row element", () => {
    expect(bufferRowAtClientY(geometry, 100)).toBe(40);
    expect(bufferRowAtClientY(geometry, 114)).toBe(40);
    expect(bufferRowAtClientY(geometry, 115)).toBe(41);
    expect(bufferRowAtClientY(geometry, 459)).toBe(63);
  });

  it("answers nothing above or below the grid", () => {
    expect(bufferRowAtClientY(geometry, 99)).toBeNull();
    expect(bufferRowAtClientY(geometry, 461)).toBeNull();
  });
});

const turn = (start: number, end: number): VisibleTurn => ({
  session: "s1",
  harness: "codex",
  turn: 7,
  ts: 1,
  role: "assistant",
  said: "hello",
  id: "s1:7",
  bufferStart: start,
  bufferEnd: end,
  anchorStart: start,
  anchorEnd: end,
  regions: [{
    id: "s1:7:r0",
    turnId: "s1:7",
    kind: "table",
    sourceStart: 0,
    sourceEnd: 2,
    bufferStart: start,
    bufferEnd: end,
    sourceBufferRows: [start, null, end],
    text: "| a |\n| - |\n| b |",
  }] as VisibleTurn["regions"],
  confidence: "anchored",
  source: "xterm+boop",
});

describe("spans slid by a scrollback trim", () => {
  it("moves the per-source-line rows a checkbox is placed by", () => {
    const [moved] = shiftSpans([turn(30, 32)], 2);
    expect(moved.regions[0].sourceBufferRows).toEqual([28, null, 30]);
    expect([moved.regions[0].bufferStart, moved.regions[0].bufferEnd]).toEqual([28, 30]);
  });

  it("hands back the same array when nothing slid", () => {
    const spans = [turn(30, 32)];
    expect(shiftSpans(spans, 0)).toBe(spans);
  });
});

describe("the scan marker", () => {
  const terminal = (marker: { line: number }) => ({ registerMarker: () => marker as IMarker });
  const marker = (line: number) => ({
    line, id: 1, isDisposed: false, dispose: () => {}, onDispose: () => ({ dispose: () => {} }),
  });

  it("reports how far the buffer trimmed since the projection was measured", () => {
    const pinned = marker(90);
    const scan = new TerminalScanShift(terminal(pinned));
    expect(scan.shift()).toBe(0);
    pinned.line = 87;
    expect(scan.shift()).toBe(3);
  });

  it("re-pins on a fresh projection, so the gap starts again from zero", () => {
    const pinned = marker(90);
    const scan = new TerminalScanShift(terminal(pinned));
    pinned.line = 87;
    scan.mark();
    expect(scan.shift()).toBe(0);
  });

  it("reports no shift once xterm has disposed the marker off the top", () => {
    const pinned = marker(0);
    const scan = new TerminalScanShift(terminal(pinned));
    pinned.line = -1;
    expect(scan.shift()).toBe(0);
  });
});
