import { describe, expect, it } from "vitest";
import { wordSpanAt, lineSpanAt } from "./0_terminalPinnedSelection";

// A tmux/codex pane row, trailing blanks and all, as translateToString gives it.
const ROW = "const shift = spans.map((s) => s.row);     ";

describe("wordSpanAt", () => {
  it("takes the word the pointer is inside", () => {
    expect(wordSpanAt(ROW, 8)).toEqual({ startCol: 6, endCol: 11 }); // "shift"
  });

  it("takes it from the first character", () => {
    expect(wordSpanAt(ROW, 6)).toEqual({ startCol: 6, endCol: 11 });
  });

  it("takes it from the last character", () => {
    expect(wordSpanAt(ROW, 10)).toEqual({ startCol: 6, endCol: 11 });
  });

  it("stops at brackets and quotes, matching xterm's own separators", () => {
    // "spans.map" sits between a space and "(", so the bracket bounds it.
    expect(wordSpanAt(ROW, 14)).toEqual({ startCol: 14, endCol: 23 });
  });

  // Nothing to select beats selecting the whole line by accident.
  it("returns null on a separator cell", () => {
    expect(wordSpanAt(ROW, 5)).toBeNull(); // the space before "shift"
  });

  it("returns null off the end of the row", () => {
    expect(wordSpanAt(ROW, 999)).toBeNull();
    expect(wordSpanAt(ROW, -1)).toBeNull();
  });

  it("takes a whole row that holds one word", () => {
    expect(wordSpanAt("solo", 2)).toEqual({ startCol: 0, endCol: 4 });
  });
});

describe("lineSpanAt", () => {
  it("stops at the last non-blank column, not the padded width", () => {
    expect(lineSpanAt(ROW)).toEqual({ startCol: 0, endCol: 38 });
  });

  it("returns null for a blank row", () => {
    expect(lineSpanAt("      ")).toBeNull();
    expect(lineSpanAt("")).toBeNull();
  });
});
