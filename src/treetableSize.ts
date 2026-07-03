// Pure width-signal helpers for TreeTable column resizing. Extracted from
// treetable.tsx to stay under the file-size cap and to keep the "when does a
// column get an explicit width" decision unit-testable with no DOM.
//
// The rule: a column gets an explicit width ONLY when it carries a signal —
// either the user dragged it (an entry in the columnSizing state) or the
// consumer authored an explicit `size`. Columns with neither stay auto-sized,
// so a table nobody has touched renders identically to a table with no resizing.
import type { ColumnSizingState } from "@tanstack/react-table";

// True when this column carries a width signal (user-dragged or consumer-set).
export function hasWidthSignal(
  columnId: string,
  columnSizing: ColumnSizingState,
  explicitSize: number | undefined,
): boolean {
  return columnSizing[columnId] !== undefined || explicitSize !== undefined;
}

// True when ANY column carries a width signal. When true the table switches to
// table-layout: fixed so the authored/dragged px widths become authoritative;
// when false every column is auto-sized and the layout is byte-identical to a
// table with resizing switched off.
export function anyWidthSignal(
  columnIds: string[],
  columnSizing: ColumnSizingState,
  explicitSizes: Record<string, number | undefined>,
): boolean {
  return columnIds.some((id) => hasWidthSignal(id, columnSizing, explicitSizes[id]));
}
