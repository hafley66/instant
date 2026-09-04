import type { IMarker, Terminal } from "@xterm/xterm";
import type { VisibleTurn } from "./0_terminalTurnVisibility";

/// Where every buffer row sits on screen, read once per paint from the cell
/// grid. Never from a row element: xterm re-creates those on every write.
export type TerminalRowGeometry = {
  /// The buffer row painted at viewport row 0.
  viewportY: number;
  rows: number;
  cellHeight: number;
  /// Host-relative top of viewport row 0.
  top: number;
  /// Host-relative left edge of the cell grid.
  left: number;
  /// Host-relative gap between the grid's right edge and the host's.
  right: number;
  /// The cell grid in client space, for pointer maths.
  screen: { top: number; bottom: number; left: number; right: number; height: number };
};

/// What the geometry needs off a terminal, narrow so a test hands a literal.
export type RowGeometryTerminal = {
  rows: Terminal["rows"];
  buffer: { active: { viewportY: number } };
};

export function readRowGeometry(
  term: RowGeometryTerminal,
  host: HTMLElement,
): TerminalRowGeometry | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const hostRect = host.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  return {
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
    cellHeight: screenRect.height / term.rows || 0,
    top: screenRect.top - hostRect.top,
    left: screenRect.left - hostRect.left,
    right: hostRect.right - screenRect.right,
    screen: {
      top: screenRect.top,
      bottom: screenRect.bottom,
      left: screenRect.left,
      right: screenRect.right,
      height: screenRect.height,
    },
  };
}

/// Host-relative top of a buffer row, on screen or off it.
export function rowTop(geometry: TerminalRowGeometry, bufferRow: number): number {
  return geometry.top + (bufferRow - geometry.viewportY) * geometry.cellHeight;
}

export function rowOnScreen(geometry: TerminalRowGeometry, bufferRow: number): boolean {
  const viewportRow = bufferRow - geometry.viewportY;
  return viewportRow >= 0 && viewportRow < geometry.rows;
}

/// The gutter column: `offset` px left of the grid, never off the host edge.
export function gutterLeft(geometry: TerminalRowGeometry, offset: number): number {
  return Math.max(2, geometry.left - offset);
}

/// The buffer row under a client y. By geometry, never by hit target: xterm
/// stacks selection and decoration layers over its rows.
export function bufferRowAtClientY(geometry: TerminalRowGeometry, clientY: number): number | null {
  if (clientY < geometry.screen.top || clientY > geometry.screen.bottom) return null;
  const viewportRow = Math.min(
    geometry.rows - 1,
    Math.max(0, Math.floor((clientY - geometry.screen.top) / (geometry.cellHeight || 1))),
  );
  return geometry.viewportY + viewportRow;
}

/// A span holds absolute buffer rows from the scan that produced it, and xterm
/// trims one line per line written once scrollback is full.
export function shiftSpans(visible: VisibleTurn[], shift: number): VisibleTurn[] {
  if (!shift) return visible;
  return visible.map((turn) => ({
    ...turn,
    bufferStart: turn.bufferStart - shift,
    bufferEnd: turn.bufferEnd - shift,
    anchorStart: turn.anchorStart - shift,
    anchorEnd: turn.anchorEnd - shift,
    regions: turn.regions.map((region) => ({
      ...region,
      bufferStart: region.bufferStart - shift,
      bufferEnd: region.bufferEnd - shift,
      sourceBufferRows: region.sourceBufferRows?.map((row) => row === null ? null : row - shift),
    })),
  }));
}

/// Pins the row the newest projection was measured against: xterm keeps a
/// marker's `line` true as scrollback trims, so the gap is how far spans slid.
export class TerminalScanShift {
  marker: IMarker | undefined;
  line = 0;

  constructor(readonly term: Pick<Terminal, "registerMarker">) {
    this.mark();
  }

  mark() {
    this.marker?.dispose();
    this.marker = this.term.registerMarker(0);
    this.line = this.marker?.line ?? 0;
  }

  shift(): number {
    const marker = this.marker;
    if (!marker || marker.line < 0) return 0;
    return this.line - marker.line;
  }

  dispose() {
    this.marker?.dispose();
    this.marker = undefined;
  }
}
