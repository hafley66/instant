import type { IDisposable, Terminal } from "@xterm/xterm";
import { Subscription } from "rxjs";
import type { TerminalLineAnchors, VisibleTerminalLine } from "./00b_terminalLineAnchors";
import {
  gutterLeft,
  readRowGeometry,
  rowOnScreen,
  rowTop,
  shiftSpans,
  TerminalScanShift,
  type TerminalRowGeometry,
} from "./0_terminalRowGeometry";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";
import type { PromptContextItem } from "./1a_terminalContextQueue";

/// How far left of the cell grid the gutter checkboxes sit.
export const gutter_offset_px = 42;
/// One checkbox's own width, border included.
export const gutter_check_px = 16;

export type StructuredSelectable = {
  id: string;
  kind: "table" | "list" | "heading";
  text: string;
  turnId: string;
  bufferRow: number;
};

const listItem = /^\s*(?:[│┃]\s*)?(?:[-+*•]|\d+[.)])\s+\S/;
const tableSeparator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;

type VisibleSourceLine = { bufferStart: number; text: string };

function normalizeSelectableLine(line: string): string {
  return line.toLowerCase().replace(/[`_*~#|]/g, " ").replace(/\s+/g, " ").trim();
}

function selectableBufferRow(
  region: VisibleTurn["regions"][number],
  sourceRow: number,
  sourceLine: string,
  visibleLines: VisibleSourceLine[],
): number | null {
  if (region.sourceBufferRows?.[sourceRow] !== null && region.sourceBufferRows?.[sourceRow] !== undefined) {
    return region.sourceBufferRows[sourceRow];
  }
  if (region.sourceBufferRows) {
    const source = normalizeSelectableLine(sourceLine);
    return visibleLines.find((line) => normalizeSelectableLine(line.text) === source)?.bufferStart ?? null;
  }
  return region.bufferStart + sourceRow;
}

export function structuredSelectables(
  turns: Array<Pick<VisibleTurn, "regions">>,
  visibleLines: VisibleSourceLine[] = [],
): StructuredSelectable[] {
  return turns.flatMap((turn) => turn.regions.flatMap((region): StructuredSelectable[] => {
    if (region.kind !== "table" && region.kind !== "list" && region.kind !== "heading") return [];
    const lines = region.text.split("\n");
    if (region.kind === "heading") {
      const bufferRow = selectableBufferRow(region, 0, lines[0], visibleLines);
      return bufferRow === null ? [] : [{
        id: `${region.id}:heading`,
        kind: "heading" as const,
        text: lines[0],
        turnId: region.turnId,
        bufferRow,
      }];
    }
    if (region.kind === "table") return lines.flatMap((line, sourceRow) => {
      const bufferRow = selectableBufferRow(region, sourceRow, line, visibleLines);
      return !line.trim() || tableSeparator.test(line) || bufferRow === null ? [] : [{
        id: `${region.id}:row:${sourceRow}`,
        kind: "table" as const,
        text: line,
        turnId: region.turnId,
        bufferRow,
      }];
    });
    const starts = lines.flatMap((line, sourceRow) => listItem.test(line) ? [sourceRow] : []);
    return starts.flatMap((sourceRow, index): StructuredSelectable[] => {
      const end = starts[index + 1] ?? lines.length;
      const bufferRow = selectableBufferRow(region, sourceRow, lines[sourceRow], visibleLines);
      if (bufferRow === null) return [];
      return [{
        id: `${region.id}:item:${sourceRow}`,
        kind: "list" as const,
        text: lines.slice(sourceRow, end).join("\n"),
        turnId: region.turnId,
        bufferRow,
      }];
    });
  }));
}

/// What one paint measured, handed to the hover checkbox and the annotation
/// marks so every gutter tenant lands on the rows the checkboxes landed on.
export type GutterPaint = {
  geometry: TerminalRowGeometry;
  /// Turn spans already slid by whatever scrollback trimmed since the scan.
  turns: VisibleTurn[];
  lines: VisibleTerminalLine[];
};

/// The slice of the queue the painter reads. Structural, so the painter never
/// imports the queue's class and the two modules stay acyclic.
export type ContextGutterHost = {
  term: Terminal;
  host: HTMLElement;
  gutter: HTMLElement;
  projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">;
  anchors: TerminalLineAnchors;
  items: Map<string, PromptContextItem>;
  enabled: () => boolean;
  toggleStructured: (selectable: StructuredSelectable, checked: boolean) => void;
};

/// Every gutter checkbox repainted from buffer-row geometry, one frame per
/// terminal signal: no debounce, no grace period, no row-element rect.
export class TerminalContextGutter {
  readonly checkboxes = new Map<string, HTMLInputElement>();
  readonly selectables = new Map<string, StructuredSelectable>();
  /// Logical lines that already carry a structured box, so the hover checkbox
  /// leaves those rows alone rather than stacking a second box on them.
  readonly paintedLineIds = new Set<string>();
  readonly followers = new Set<(paint: GutterPaint) => void>();
  readonly scan: TerminalScanShift;
  readonly disposables: IDisposable[];
  readonly subscription = new Subscription();
  frame = 0;

  constructor(readonly queue: ContextGutterHost) {
    this.scan = new TerminalScanShift(queue.term);
    this.subscription.add(queue.projection.changes.subscribe(() => {
      this.scan.mark();
      this.schedule();
    }));
    this.subscription.add(queue.anchors.visible.$.subscribe(() => this.schedule()));
    this.disposables = [
      queue.term.onScroll(() => this.schedule()),
      queue.term.onResize(() => this.schedule()),
      queue.term.onWriteParsed(() => this.schedule()),
    ];
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  checkboxFor(selectable: StructuredSelectable): HTMLInputElement {
    const existing = this.checkboxes.get(selectable.id);
    if (existing) return existing;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "term-context-structured-check";
    checkbox.dataset.regionId = selectable.id;
    checkbox.title = selectable.kind === "heading"
      ? "Add heading to next prompt"
      : `Add ${selectable.kind} row to next prompt`;
    checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      const current = this.selectables.get(selectable.id);
      if (current) this.queue.toggleStructured(current, checkbox.checked);
    });
    this.queue.gutter.appendChild(checkbox);
    this.checkboxes.set(selectable.id, checkbox);
    return checkbox;
  }

  paint() {
    const geometry = readRowGeometry(this.queue.term, this.queue.host);
    if (!geometry) return;
    const lines = this.queue.anchors.visible.$();
    const turns = this.queue.enabled()
      ? shiftSpans(this.queue.projection.visible, this.scan.shift())
      : [];
    const selectables = structuredSelectables(turns, lines);
    const left = gutterLeft(geometry, gutter_offset_px);
    this.selectables.clear();
    this.paintedLineIds.clear();
    for (const selectable of selectables) {
      this.selectables.set(selectable.id, selectable);
      const checkbox = this.checkboxFor(selectable);
      checkbox.dataset.turnId = selectable.turnId;
      checkbox.hidden = !rowOnScreen(geometry, selectable.bufferRow);
      if (checkbox.hidden) continue;
      checkbox.checked = this.queue.items.has(selectable.id);
      checkbox.dataset.bufferRow = String(selectable.bufferRow);
      const line = lines.find((candidate) =>
        candidate.bufferStart <= selectable.bufferRow && selectable.bufferRow <= candidate.bufferEnd);
      if (line) {
        checkbox.dataset.terminalLineId = line.id;
        this.paintedLineIds.add(line.id);
      }
      checkbox.style.left = `${left}px`;
      checkbox.style.top = `${rowTop(geometry, selectable.bufferRow)}px`;
    }
    const liveTurns = new Set(turns.map((turn) => turn.id));
    for (const [id, checkbox] of this.checkboxes) {
      if (this.selectables.has(id)) continue;
      checkbox.hidden = true;
      if (liveTurns.has(checkbox.dataset.turnId ?? "")) continue;
      checkbox.remove();
      this.checkboxes.delete(id);
    }
    for (const follower of this.followers) follower({ geometry, turns, lines });
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.subscription.unsubscribe();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.scan.dispose();
    for (const checkbox of this.checkboxes.values()) checkbox.remove();
    this.checkboxes.clear();
    this.selectables.clear();
    this.paintedLineIds.clear();
    this.followers.clear();
  }
}
