// The token a ⌘-click or hover names, read from an xterm buffer. Pure over
// IBuffer, so a Terminal that was never opened drives it under vitest.
import type { IBuffer } from "@xterm/xterm";
import { tokenAtColumn, widenAcrossSpaces } from "./termTokens";
import {
  joinWrappedRows,
  capWrappedRows,
  softWrappedPathLink,
  MAX_WRAP_ROWS,
  type WrapRow,
} from "./termWrapJoin";

export type BufferRows = { rows: WrapRow[]; index: number; start: number };

// Rows that continue keep trailing spaces so joined offsets stay true; the
// walk is capped at MAX_WRAP_ROWS and degrades to the requested row past it.
export function wrappedLineRows(buf: IBuffer, bufferRow: number): BufferRows | null {
  if (!buf.getLine(bufferRow)) return null;

  let start = bufferRow;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;

  const collected: WrapRow[] = [];
  let clickedIndex = -1;
  let overCap = false;
  for (let b = start, n = 0; ; b++, n++) {
    const line = buf.getLine(b);
    if (!line) break;
    if (b === bufferRow) clickedIndex = n;
    const continued = buf.getLine(b + 1)?.isWrapped ?? false;
    collected.push({ text: line.translateToString(!continued), isWrapped: line.isWrapped });
    if (!continued) break;
    if (n + 1 >= MAX_WRAP_ROWS) {
      overCap = true;
      break;
    }
  }
  if (clickedIndex < 0) return null;
  const capped = capWrappedRows(collected, clickedIndex, overCap);
  return { rows: capped.rows, index: capped.index, start };
}

// The rows within a few lines of `bufferRow`, trimmed, for the TUI-wrap join.
export function softPathRows(buf: IBuffer, bufferRow: number): BufferRows | null {
  const radius = 4;
  const start = Math.max(0, bufferRow - radius);
  const end = Math.min(buf.length - 1, bufferRow + radius);
  const rows: WrapRow[] = [];
  for (let row = start; row <= end; row++) {
    const line = buf.getLine(row);
    if (!line) return null;
    rows.push({ text: line.translateToString(true), isWrapped: line.isWrapped });
  }
  return { rows, index: bufferRow - start, start };
}

// `wide` (a path grown across spaces or a rejoined TUI wrap) resolves first,
// `narrow` (the word on the clicked row) on a miss.
export function bufferClickToken(
  buf: IBuffer,
  bufferRow: number,
  col: number,
  openable: (text: string) => boolean,
): { wide: string; narrow: string } {
  const softRows = softPathRows(buf, bufferRow);
  const soft = softRows && softWrappedPathLink(softRows.rows, softRows.index, openable)
    .find((link) => col >= link.range.startCol && col < link.range.endCol);
  if (soft) {
    // A block of complete paths also passes the join; `narrow` is the one path
    // under the pointer for when the stitched run names nothing on disk.
    const rowText = buf.getLine(bufferRow)?.translateToString(true) ?? "";
    const rowSpan = tokenAtColumn(rowText, col);
    return { wide: soft.text, narrow: rowSpan?.text ?? soft.text };
  }
  const wrapped = wrappedLineRows(buf, bufferRow);
  if (!wrapped) return { wide: "", narrow: "" };
  const joined = joinWrappedRows(wrapped.rows);
  const offset = joined.rowStartOffsets[wrapped.index] + col;
  const span = tokenAtColumn(joined.text, offset);
  if (!span) return { wide: "", narrow: "" };
  const wide = widenAcrossSpaces(joined.text, span);
  return { wide: wide.text, narrow: span.text };
}
