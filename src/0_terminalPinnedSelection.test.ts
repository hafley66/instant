import { describe, expect, it } from "vitest";
import {
  isEmptySelection,
  joinPinnedRows,
  orderedSelection,
  pinnedRowSpans,
} from "./0_terminalPinnedSelection";

const cell = (row: number, col: number) => ({ row, col });

describe("pinned terminal selection geometry", () => {
  it("orders a drag that ran up and to the left", () => {
    expect(orderedSelection({ anchor: cell(4, 12), focus: cell(2, 3) })).toEqual({
      anchor: cell(2, 3),
      focus: cell(4, 12),
    });
    expect(orderedSelection({ anchor: cell(2, 9), focus: cell(2, 3) })).toEqual({
      anchor: cell(2, 3),
      focus: cell(2, 9),
    });
  });

  it("spans the dragged columns on a single row, covering the focus cell", () => {
    expect(pinnedRowSpans({ anchor: cell(1, 4), focus: cell(1, 11) }, 80)).toEqual([
      { row: 1, startCol: 4, endCol: 12 },
    ]);
  });

  it("reads a right-to-left drag as the same span as a left-to-right one", () => {
    expect(pinnedRowSpans({ anchor: cell(1, 11), focus: cell(1, 4) }, 80)).toEqual(
      pinnedRowSpans({ anchor: cell(1, 4), focus: cell(1, 11) }, 80),
    );
  });

  it("runs interior rows the full width", () => {
    expect(pinnedRowSpans({ anchor: cell(1, 60), focus: cell(3, 5) }, 80)).toEqual([
      { row: 1, startCol: 60, endCol: 80 },
      { row: 2, startCol: 0, endCol: 80 },
      { row: 3, startCol: 0, endCol: 6 },
    ]);
  });

  it("reads a press that never travelled as no selection", () => {
    expect(isEmptySelection({ anchor: cell(2, 7), focus: cell(2, 7) })).toBe(true);
    expect(isEmptySelection({ anchor: cell(2, 7), focus: cell(2, 8) })).toBe(false);
    expect(isEmptySelection({ anchor: cell(2, 7), focus: cell(3, 7) })).toBe(false);
  });

  it("right-trims each copied row and joins with newlines", () => {
    expect(joinPinnedRows(["alpha beta   ", "second line ", ""])).toBe("alpha beta\nsecond line\n");
  });
});
