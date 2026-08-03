// Joining a hard-wrapped terminal line back into one string, and splitting a
// span over that string back onto the per-row ranges a link must cover. Pure
// over strings: the buffer is read and joined in terminal.ts, so these run
// under vitest with no terminal. Row text lengths come from the real strings,
// never from a cols count, because wide glyphs make cell-count != char-count.
import { scanLineTokens } from "./termTokens";

// A hard wrap inserts nothing between rows, so plain concatenation keeps every
// offset truthful: joined text is row0 + row1 + ... and each row's start offset
// is the running length of the rows before it.
export type WrapRow = {
  // The row text exactly as it was joined, and whether this row continues the
  // one above it.
  text: string;
  isWrapped: boolean;
};

export type JoinedLine = {
  text: string;
  // rowStartOffsets[i] = index of row i's first character in `text`.
  rowStartOffsets: number[];
};

export type RowRange = {
  // Index into the WrapRow list the range came from (0 = first row of the line).
  rowIndex: number;
  // 0-based half-open column range within that row's text.
  startCol: number;
  endCol: number;
};

export function joinWrappedRows(rows: WrapRow[]): JoinedLine {
  const rowStartOffsets: number[] = new Array(rows.length);
  let text = "";
  for (let i = 0; i < rows.length; i++) {
    rowStartOffsets[i] = text.length;
    text += rows[i].text;
  }
  return { text, rowStartOffsets };
}

// A span ([start, end) over the joined text) touches one row per boundary it
// crosses; each touch yields the sub-range of the span that falls in that row.
export function mapSpanToRowRanges(
  span: { start: number; end: number },
  joined: JoinedLine,
): RowRange[] {
  const ranges: RowRange[] = [];
  for (let i = 0; i < joined.rowStartOffsets.length; i++) {
    const rowStart = joined.rowStartOffsets[i];
    const rowEnd =
      i + 1 < joined.rowStartOffsets.length
        ? joined.rowStartOffsets[i + 1]
        : joined.text.length;
    const colStart = Math.max(span.start, rowStart);
    const colEnd = Math.min(span.end, rowEnd);
    if (colStart < colEnd) {
      ranges.push({ rowIndex: i, startCol: colStart - rowStart, endCol: colEnd - rowStart });
    }
  }
  return ranges;
}

// The logical-line walk is capped so a many-row continuation never becomes a
// whole-buffer scan.
export const MAX_WRAP_ROWS = 40;

// When a logical line ran past the cap, degrade it to the single clicked row so
// the wrap fix quietly falls back to the original per-row behavior.
export function capWrappedRows(
  rows: WrapRow[],
  clickedIndex: number,
  overCap: boolean,
): { rows: WrapRow[]; index: number } {
  if (!overCap || rows.length === 0) return { rows, index: clickedIndex };
  const single = rows[Math.max(0, clickedIndex)];
  return { rows: [{ text: single.text ?? "", isWrapped: false }], index: 0 };
}

// Scan a joined logical line with the one shared scanner, keep the openable
// spans, and split each onto the rows it crosses. Openability is injected so
// this module never imports terminal or click-rule code.
export function wrappedLinkSpans(
  rows: WrapRow[],
  openable: (text: string) => boolean,
): Array<{ text: string; ranges: RowRange[] }> {
  const joined = joinWrappedRows(rows);
  return scanLineTokens(joined.text)
    .filter((span) => openable(span.text))
    .map((span) => ({ text: span.text, ranges: mapSpanToRowRanges(span, joined) }));
}
