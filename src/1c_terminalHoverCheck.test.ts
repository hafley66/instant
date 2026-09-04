import { describe, expect, it } from "vitest";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import { gutter_offset_px, hoverLineId, hoverTargetAt, screenRowAt } from "./1c_terminalHoverCheck";

const line = (id: string, start: number, end: number, text: string): VisibleTerminalLine =>
  ({ id, bufferStart: start, bufferEnd: end, viewportStart: start, viewportEnd: end, text });

describe("hover gutter checkbox", () => {
  const lines = [
    line("a", 10, 10, "const shift = spans.map((s) => s.row);"),
    line("b", 11, 12, "a wrapped line that spans two rows"),
    line("c", 13, 13, "   "),
  ];

  it("resolves any row of a wrapped logical line to that line", () => {
    expect(hoverTargetAt(lines, 12)?.id).toBe("b");
    expect(hoverTargetAt(lines, 11)?.id).toBe("b");
  });

  it("offers nothing on a blank line or off the visible lines", () => {
    expect(hoverTargetAt(lines, 13)).toBeNull();
    expect(hoverTargetAt(lines, 99)).toBeNull();
  });

  it("names the queued item after the line, so a second click unchecks", () => {
    expect(hoverLineId(lines[0])).toBe("line:a");
  });
});

describe("screen row under the pointer", () => {
  const screen = { top: 100, bottom: 340, left: 60, right: 700, height: 240 };

  it("maps a y inside the screen to its row, across the gutter to the left", () => {
    expect(screenRowAt(screen, 24, 200, 100)).toBe(0);
    expect(screenRowAt(screen, 24, 200, 109)).toBe(0);
    expect(screenRowAt(screen, 24, 200, 110)).toBe(1);
    expect(screenRowAt(screen, 24, 60 - gutter_offset_px, 335)).toBe(23);
  });

  it("answers nothing above, below, right of the screen, or left of the gutter", () => {
    expect(screenRowAt(screen, 24, 200, 99)).toBeNull();
    expect(screenRowAt(screen, 24, 200, 340)).toBeNull();
    expect(screenRowAt(screen, 24, 700, 200)).toBeNull();
    expect(screenRowAt(screen, 24, 0, 200)).toBeNull();
  });
});
