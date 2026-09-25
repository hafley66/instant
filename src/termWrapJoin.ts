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

export type SoftPathLink = {
  text: string;
  range: RowRange;
};

// A TUI-wrapped path: a row-ending token with a `/` joins the next row's first
// token (prose may follow a path-like one); one-token rows pass the chain on.
export function softWrappedPathLink(
  rows: WrapRow[],
  requestedIndex: number,
  openable: (text: string) => boolean,
): SoftPathLink[] {
  const tokens = rows.map((row) => scanLineTokens(row.text));
  const fragments = rows.map((row, index) => {
    const rowTokens = tokens[index];
    return {
      first: rowTokens[0],
      last: rowTokens[rowTokens.length - 1],
      end: row.text.trimEnd().length,
    };
  });
  const single = (index: number) => fragments[index].first === fragments[index].last;
  function joins(leftIndex: number): boolean {
    const left = fragments[leftIndex];
    const right = fragments[leftIndex + 1];
    if (!left?.last || !right?.first) return false;
    if (rows[leftIndex + 1].isWrapped) return false;
    if (left.last.end !== left.end) return false;
    // Prose after the fragment: the fragment itself must look like a path.
    if (right.first !== right.last && !openable(right.first.text)) return false;
    const combined = left.last.text + right.first.text;
    // A one-token row inside a chain carries the head's `/`.
    const pathy = left.last.text.includes("/") || (single(leftIndex) && leftIndex > 0 && joins(leftIndex - 1));
    return pathy && !/[\s'"`()<>[\]{}]/.test(combined) && openable(combined);
  }
  // The first row of the chain through `index`'s first token.
  const headOf = (index: number) => {
    let start = index;
    while (start > 0 && joins(start - 1)) {
      start--;
      if (!single(start)) break;
    }
    return start;
  };
  // The last row of the chain through `index`'s last token.
  const tailOf = (index: number) => {
    let end = index;
    while (end + 1 < rows.length && joins(end)) {
      end++;
      if (!single(end)) break;
    }
    return end;
  };
  const link = (start: number, end: number): SoftPathLink | null => {
    if (start === end) return null;
    const parts = [];
    for (let index = start; index <= end; index++) {
      const token = index === start ? fragments[index].last : fragments[index].first;
      if (!token) return null;
      parts.push(token.text);
    }
    const requested = requestedIndex === start
      ? fragments[requestedIndex].last
      : fragments[requestedIndex].first;
    if (!requested) return null;
    return {
      text: parts.join(""),
      range: { rowIndex: requestedIndex, startCol: requested.start, endCol: requested.end },
    };
  };

  if (!fragments[requestedIndex]?.first) return [];
  const head = headOf(requestedIndex);
  if (single(requestedIndex)) {
    const one = link(head, tailOf(requestedIndex));
    return one ? [one] : [];
  }
  return [link(head, requestedIndex), link(requestedIndex, tailOf(requestedIndex))]
    .filter((found): found is SoftPathLink => found !== null);
}
