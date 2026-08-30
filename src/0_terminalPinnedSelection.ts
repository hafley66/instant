// tmux `mouse on` puts xterm into DECSET 1000/1002/1006; xterm answers by
// calling SelectionService.disable() and by clearing on every forwarded mouse
// report, so a plain drag over a codex pane selects nothing.
import type { IDisposable, Terminal } from "@xterm/xterm";

export type SelectionCell = { row: number; col: number };
export type PinnedSelection = { anchor: SelectionCell; focus: SelectionCell };
export type PinnedRowSpan = { row: number; startCol: number; endCol: number };

// Anchor and focus in the order the buffer reads them (top-left first).
export function orderedSelection(selection: PinnedSelection): PinnedSelection {
  const { anchor, focus } = selection;
  const reversed = focus.row < anchor.row || (focus.row === anchor.row && focus.col < anchor.col);
  return reversed ? { anchor: focus, focus: anchor } : selection;
}

// One half-open [startCol, endCol) span per buffer row the selection covers,
// with interior rows running the full width. Both cells name the character
// under the pointer, so the last row reads one column past its focus.
export function pinnedRowSpans(selection: PinnedSelection, cols: number): PinnedRowSpan[] {
  const { anchor, focus } = orderedSelection(selection);
  const spans: PinnedRowSpan[] = [];
  for (let row = anchor.row; row <= focus.row; row++) {
    const startCol = row === anchor.row ? anchor.col : 0;
    const endCol = row === focus.row ? Math.min(cols, focus.col + 1) : cols;
    if (endCol > startCol) spans.push({ row, startCol, endCol });
  }
  return spans;
}

// xterm's own default (ITerminalOptions.wordSeparator). Matching it keeps a
// double-click on a codex pane picking the same word it would on a plain one.
const WORD_SEPARATORS = " ()[]{}',\"`";

/// The word under `col` as a half-open [startCol, endCol), or null when the
/// cell itself is a separator so there is no word to take.
export function wordSpanAt(text: string, col: number): { startCol: number; endCol: number } | null {
  if (col < 0 || col >= text.length) return null;
  if (WORD_SEPARATORS.includes(text[col])) return null;
  let startCol = col;
  let endCol = col + 1;
  while (startCol > 0 && !WORD_SEPARATORS.includes(text[startCol - 1])) startCol--;
  while (endCol < text.length && !WORD_SEPARATORS.includes(text[endCol])) endCol++;
  return { startCol, endCol };
}

/// The row's text without its trailing blanks, or null for a blank row.
export function lineSpanAt(text: string): { startCol: number; endCol: number } | null {
  const endCol = text.replace(/\s+$/, "").length;
  return endCol > 0 ? { startCol: 0, endCol } : null;
}

// A press with no travel is a click, so the caller can leave it to the pane.
export function isEmptySelection(selection: PinnedSelection): boolean {
  const { anchor, focus } = selection;
  return anchor.row === focus.row && anchor.col === focus.col;
}

// Rows join with \n, and each row is right-trimmed the way xterm's own
// getSelection does, so a copied block has no trailing padding.
export function joinPinnedRows(rows: string[]): string {
  return rows.map((row) => row.replace(/\s+$/, "")).join("\n");
}

export type PinnedSelectionOptions = {
  copy: (text: string) => void;
};

export class TerminalPinnedSelection {
  readonly root: HTMLElement;
  selection: PinnedSelection | null = null;
  captured: string[] = [];
  anchor: SelectionCell | null = null;
  dragging = false;
  frame = 0;
  render: IDisposable;
  resize: IDisposable;
  readonly onMouseDown = (event: MouseEvent) => this.mouseDown(event);
  readonly onMouseMove = (event: MouseEvent) => this.mouseMove(event);
  readonly onMouseUp = (event: MouseEvent) => this.mouseUp(event);

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly options: PinnedSelectionOptions,
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-pinned-root";
    host.appendChild(this.root);
    host.addEventListener("mousedown", this.onMouseDown, { capture: true });
    this.render = term.onRender(() => this.schedule());
    this.resize = term.onResize(() => this.clear());
  }

  // The screen box every cell coordinate is measured against, and its offset
  // inside the host so painted rects land on the same cells the reader sees.
  geometry() {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen") ?? this.host;
    const screenBox = screen.getBoundingClientRect();
    const hostBox = this.host.getBoundingClientRect();
    return {
      left: screenBox.left - hostBox.left,
      top: screenBox.top - hostBox.top,
      pageLeft: screenBox.left,
      pageTop: screenBox.top,
      cellWidth: screenBox.width / this.term.cols || 1,
      cellHeight: screenBox.height / this.term.rows || 1,
    };
  }

  // The absolute buffer cell under a viewport point, clamped to the grid.
  cellAt(clientX: number, clientY: number): SelectionCell {
    const box = this.geometry();
    const rawRow = Math.floor((clientY - box.pageTop) / box.cellHeight);
    const rawCol = Math.floor((clientX - box.pageLeft) / box.cellWidth);
    const row = Math.max(0, Math.min(this.term.rows - 1, rawRow));
    const col = Math.max(0, Math.min(this.term.cols - 1, rawCol));
    return { row: this.term.buffer.active.viewportY + row, col };
  }

  rowText(span: PinnedRowSpan): string {
    const line = this.term.buffer.active.getLine(span.row);
    return line ? line.translateToString(false, span.startCol, span.endCol) : "";
  }

  text(): string {
    return this.selection ? joinPinnedRows(this.captured) : "";
  }

  hasSelection(): boolean {
    return !!this.selection && this.captured.some((row) => row.trim().length > 0);
  }

  // With tracking off xterm makes its own selection, and a second painted
  // highlight would double it.
  appOwnsMouse(): boolean {
    return this.term.modes.mouseTrackingMode !== "none";
  }

  mouseDown(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement | null)?.closest?.(".term-diagrams")) return;
    this.clear();
    if (!this.appOwnsMouse()) return;
    // A pane whose app owns the mouse has xterm's own selection disabled, so
    // double- and triple-click reached neither xterm nor this overlay and
    // picked nothing at all. `detail` counts the clicks in the streak.
    if (event.detail >= 2) {
      const cell = this.cellAt(event.clientX, event.clientY);
      if (event.detail === 2) this.selectWordAt(cell);
      else this.selectLineAt(cell);
      return;
    }
    this.anchor = this.cellAt(event.clientX, event.clientY);
    this.dragging = false;
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("mouseup", this.onMouseUp, true);
  }

  /// Both cells name a character, so `focus.col` is the last column taken and a
  /// half-open span ends one past it.
  selectSpan(row: number, span: { startCol: number; endCol: number } | null) {
    if (!span) return;
    this.selection = {
      anchor: { row, col: span.startCol },
      focus: { row, col: span.endCol - 1 },
    };
    this.capture();
    this.paint();
    this.settle();
  }

  selectWordAt(cell: SelectionCell) {
    const line = this.term.buffer.active.getLine(cell.row);
    if (!line) return;
    this.selectSpan(cell.row, wordSpanAt(line.translateToString(false), cell.col));
  }

  selectLineAt(cell: SelectionCell) {
    const line = this.term.buffer.active.getLine(cell.row);
    if (!line) return;
    this.selectSpan(cell.row, lineSpanAt(line.translateToString(false)));
  }

  mouseMove(event: MouseEvent) {
    if (!this.anchor) return;
    const candidate: PinnedSelection = { anchor: this.anchor, focus: this.cellAt(event.clientX, event.clientY) };
    if (!this.dragging && isEmptySelection(candidate)) return;
    this.dragging = true;
    this.selection = candidate;
    this.capture();
    this.paint();
  }

  mouseUp(_event: MouseEvent) {
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("mouseup", this.onMouseUp, true);
    this.anchor = null;
    if (!this.dragging) return;
    this.dragging = false;
    this.settle();
  }

  /// One place a finished selection is handed on, so a drag and a
  /// double-click deliver the same thing to the same listener.
  settle() {
    const text = this.text();
    if (!text || !this.selection) return;
    this.options.copy(text);
  }

  capture() {
    if (!this.selection) return;
    this.captured = pinnedRowSpans(this.selection, this.term.cols).map((span) => this.rowText(span));
  }

  schedule() {
    if (this.frame || !this.selection) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.syncToBuffer();
    });
  }

  // A repaint that leaves the pinned characters alone keeps the highlight; one
  // that rewrites them drops it, so the paint never lies about what it covers.
  syncToBuffer() {
    if (!this.selection) return;
    const spans = pinnedRowSpans(this.selection, this.term.cols);
    const live = spans.map((span) => this.rowText(span));
    if (live.length !== this.captured.length || live.some((row, index) => row !== this.captured[index])) {
      this.clear();
      return;
    }
    this.paint();
  }

  paint() {
    if (!this.selection) return;
    const box = this.geometry();
    const spans = pinnedRowSpans(this.selection, this.term.cols);
    const top = this.term.buffer.active.viewportY;
    const rects = spans.filter((span) => span.row >= top && span.row < top + this.term.rows);
    while (this.root.childElementCount > rects.length) this.root.lastElementChild!.remove();
    while (this.root.childElementCount < rects.length) {
      const rect = document.createElement("div");
      rect.className = "term-pinned-selection";
      this.root.appendChild(rect);
    }
    rects.forEach((span, index) => {
      const rect = this.root.children[index] as HTMLElement;
      rect.style.left = `${box.left + span.startCol * box.cellWidth}px`;
      rect.style.top = `${box.top + (span.row - top) * box.cellHeight}px`;
      rect.style.width = `${(span.endCol - span.startCol) * box.cellWidth}px`;
      rect.style.height = `${box.cellHeight}px`;
    });
  }

  clear() {
    this.selection = null;
    this.captured = [];
    this.root.replaceChildren();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.host.removeEventListener("mousedown", this.onMouseDown, { capture: true });
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("mouseup", this.onMouseUp, true);
    this.render.dispose();
    this.resize.dispose();
    this.root.remove();
  }
}
