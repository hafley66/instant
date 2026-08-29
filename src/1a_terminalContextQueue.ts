import type { Terminal } from "@xterm/xterm";
import { Signal } from "@hafley66/signals";
import { debounceTime, filter, merge, Observable, share, startWith, Subscription, switchMap, take, tap } from "rxjs";
import type { TerminalLineAnchors } from "./00b_terminalLineAnchors";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";

export type PromptContextItem = {
  id: string;
  kind: "selection" | "table" | "list";
  text: string;
  turnIds: string[];
  enabled: boolean;
};

export type TerminalSelectionSnapshot = {
  text: string;
  bufferStart: { row: number; col: number };
  bufferEnd: { row: number; col: number };
  turnIds: string[];
};

export function formatQueuedContext(items: PromptContextItem[]): string {
  const selected = items.filter((item) => item.enabled && item.text.trim());
  if (!selected.length) return "";
  return `Selected context:\n\n${selected.map((item) => {
    const source = item.turnIds.length ? `turn ${item.turnIds.join(", ")}` : "terminal selection";
    return `[${source}]\n${item.text.trim()}`;
  }).join("\n\n")}\n\n`;
}

// Tags a selection with the turns whose own text it overlaps, never with a
// turn whose extended span merely reaches across it.
function turnsAcrossRange(turns: VisibleTurn[], start: number, end: number): string[] {
  return turns
    .filter((turn) => turn.anchorEnd >= start && turn.anchorStart <= end)
    .map((turn) => turn.id);
}

type StructuredSelectable = {
  id: string;
  kind: "table" | "list";
  text: string;
  turnId: string;
  bufferRow: number;
};

const listItem = /^\s*(?:[│┃]\s*)?(?:[-+*•]|\d+[.)])\s+\S/;
const tableSeparator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;

type VisibleSourceLine = { bufferStart: number; text: string };
const projection_grace_ms = 2000;

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
    if (region.kind !== "table" && region.kind !== "list") return [];
    const lines = region.text.split("\n");
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
    const sourceItems = starts.flatMap((sourceRow, index): StructuredSelectable[] => {
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
    return sourceItems;
  }));
}

export class TerminalContextQueue {
  root = document.createElement("div");
  gutter = document.createElement("div");
  selectionAction = document.createElement("button");
  queue = document.createElement("section");
  items = new Map<string, PromptContextItem>();
  checkboxes = new Map<string, HTMLInputElement>();
  paintedLineIds = new Set<string>();
  paintDirty = true;
  revealFrame = 0;
  selection: TerminalSelectionSnapshot | null = null;
  readonly state = Signal<PromptContextItem[]>([]);
  readonly changes: Observable<PromptContextItem[]> = this.state.$;
  projectionSubscription: Subscription;
  anchorSubscription: Subscription;
  selectionListener: { dispose(): void } | null = null;
  lifetime = new Subscription();

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
    readonly anchors: TerminalLineAnchors,
    readonly paste: (text: string) => void,
    readonly enabled: () => boolean,
  ) {
    this.root.className = "term-context-root";
    this.gutter.className = "term-context-gutter";
    this.selectionAction.className = "term-context-selection-add";
    this.selectionAction.type = "button";
    this.selectionAction.textContent = "+ next";
    this.selectionAction.hidden = true;
    this.queue.className = "term-context-queue";
    this.queue.hidden = true;
    this.root.append(this.gutter, this.selectionAction, this.queue);
    host.appendChild(this.root);
    // A drag-selection in the terminal offers "+ next" instead of vanishing into
    // a clipboard. Clicking it parks the text in the queue below; the selection
    // itself is only cleared once the text is safely in an item.
    this.selectionAction.addEventListener("mousedown", (event) => event.stopPropagation());
    this.selectionAction.addEventListener("click", () => this.addSelection());
    this.selectionListener = term.onSelectionChange(() => this.captureSelection());
    this.projectionSubscription = projection.changes.pipe(debounceTime(100)).subscribe(() => {
      this.paintDirty = true;
      if (!this.gutter.hidden) this.paintSelections();
    });
    const viewport_changes = anchors.viewport.changes.pipe(share());
    const selection_motion = anchors.events.$.pipe(filter((events) =>
      events.some((event) =>
        event.kind === "viewport-jump" || event.kind === "top-line-changed" ||
        event.kind === "exited" && this.paintedLineIds.has(event.id) ||
        "line" in event && this.paintedLineIds.has(event.line.id)),
    ));
    this.lifetime.add(anchors.events.$.subscribe(() => {
      this.positionSelectionAction();
    }));
    const viewport_motion = viewport_changes.pipe(
      filter((event) => event.kind === "scroll" || event.kind === "resize"),
    );
    this.anchorSubscription = merge(selection_motion, viewport_motion).pipe(
      tap(() => this.invalidateSelections()),
      switchMap(() => viewport_changes.pipe(startWith(null), debounceTime(650), take(1))),
    ).subscribe(() => {
      this.anchors.refresh();
      if (this.paintDirty) this.paintSelections();
    });
    this.paintSelections();
  }

  captureSelection() {
    const text = this.term.getSelection();
    const range = this.term.getSelectionPosition();
    if (!text || !range) {
      this.selection = null;
      this.selectionAction.hidden = true;
      return;
    }
    const start = Math.min(range.start.y, range.end.y);
    const end = Math.max(range.start.y, range.end.y);
    this.selection = {
      text,
      bufferStart: { row: range.start.y, col: range.start.x },
      bufferEnd: { row: range.end.y, col: range.end.x },
      turnIds: turnsAcrossRange(this.projection.visible, start, end),
    };
    this.selectionAction.hidden = false;
    this.positionSelectionAction();
  }

  positionSelectionAction() {
    if (!this.selection || this.selectionAction.hidden) return;
    const row = Math.max(
      this.term.buffer.active.viewportY,
      Math.min(this.selection.bufferStart.row, this.term.buffer.active.viewportY + this.term.rows - 1),
    );
    const anchor = this.anchors.elementForBufferRow(row);
    if (!anchor) {
      this.selectionAction.hidden = true;
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    Object.assign(this.selectionAction.style, {
      left: `${Math.max(4, rect.left - hostRect.left + 8)}px`,
      top: `${rect.top - hostRect.top}px`,
    });
  }

  addSelection() {
    if (!this.selection) return;
    const id = `selection:${Date.now()}:${this.items.size}`;
    this.items.set(id, {
      id,
      kind: "selection",
      text: this.selection.text,
      turnIds: this.selection.turnIds,
      enabled: true,
    });
    this.selection = null;
    this.selectionAction.hidden = true;
    this.term.clearSelection();
    this.renderQueue();
  }

  toggleStructured(selectable: StructuredSelectable, checked: boolean) {
    if (checked) {
      this.items.set(selectable.id, {
        id: selectable.id,
        kind: selectable.kind,
        text: selectable.text,
        turnIds: [selectable.turnId],
        enabled: true,
      });
    } else {
      this.items.delete(selectable.id);
    }
    this.renderQueue();
  }

  invalidateSelections() {
    this.paintDirty = true;
    if (this.revealFrame) cancelAnimationFrame(this.revealFrame);
    this.revealFrame = 0;
    this.gutter.hidden = true;
  }

  clearSelections() {
    this.checkboxes.clear();
    this.paintedLineIds.clear();
    this.gutter.replaceChildren();
    this.gutter.hidden = false;
  }

  activate() {
    this.anchors.refresh();
    this.paintDirty = true;
    this.paintSelections();
  }

  paintSelections() {
    if (this.revealFrame) cancelAnimationFrame(this.revealFrame);
    this.revealFrame = 0;
    this.gutter.hidden = true;
    if (!this.enabled()) {
      this.clearSelections();
      this.paintDirty = false;
      return;
    }
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const live = new Set<string>();
    const now = performance.now();
    this.paintedLineIds.clear();
    const visibleByLineId = new Map(this.anchors.visible.$().map((line) => [line.id, line]));
    for (const [id, checkbox] of this.checkboxes) {
      checkbox.hidden = true;
      const confirmed_at = Number(checkbox.dataset.confirmedAt ?? 0);
      if (now - confirmed_at > projection_grace_ms) continue;
      const lineId = checkbox.dataset.terminalLineId;
      const line = lineId ? visibleByLineId.get(lineId) : undefined;
      if (!line) continue;
      const anchor = this.anchors.elementForBufferRow(line.bufferStart);
      if (!anchor) continue;
      live.add(id);
      checkbox.hidden = false;
      this.paintedLineIds.add(line.id);
      const anchorRect = anchor.getBoundingClientRect();
      Object.assign(checkbox.style, {
        left: `${Math.max(2, screenRect.left - hostRect.left - 42)}px`,
        top: `${anchorRect.top - hostRect.top}px`,
      });
    }
    for (const selectable of structuredSelectables(this.projection.visible, this.anchors.visible.$())) {
      if (selectable.bufferRow < top || selectable.bufferRow > bottom) continue;
      live.add(selectable.id);
      const anchor = this.anchors.elementForBufferRow(selectable.bufferRow);
      if (!anchor) continue;
      let checkbox = this.checkboxes.get(selectable.id);
      if (!checkbox) {
        checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "term-context-structured-check";
        checkbox.dataset.regionId = selectable.id;
        checkbox.title = `Add ${selectable.kind} row to next prompt`;
        checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
        checkbox.addEventListener("change", () => this.toggleStructured(selectable, checkbox!.checked));
        this.gutter.appendChild(checkbox);
        this.checkboxes.set(selectable.id, checkbox);
      }
      checkbox.checked = this.items.has(selectable.id);
      checkbox.hidden = false;
      checkbox.dataset.confirmedAt = String(now);
      checkbox.dataset.terminalLineId = anchor.dataset.terminalLineId;
      if (anchor.dataset.terminalLineId) this.paintedLineIds.add(anchor.dataset.terminalLineId);
      const anchorRect = anchor.getBoundingClientRect();
      Object.assign(checkbox.style, {
        left: `${Math.max(2, screenRect.left - hostRect.left - 42)}px`,
        top: `${anchorRect.top - hostRect.top}px`,
      });
    }
    for (const [id, checkbox] of this.checkboxes) {
      const expired = now - Number(checkbox.dataset.confirmedAt ?? 0) > projection_grace_ms;
      const over_limit = this.checkboxes.size > 512;
      if (live.has(id) || !checkbox.hidden || !expired && !over_limit) continue;
        checkbox.remove();
        this.checkboxes.delete(id);
    }
    this.paintDirty = false;
    this.revealFrame = requestAnimationFrame(() => {
      this.revealFrame = 0;
      if (!this.paintDirty && this.enabled()) this.gutter.hidden = false;
    });
  }

  renderQueue() {
    this.queue.replaceChildren();
    if (!this.items.size) {
      this.queue.hidden = true;
      this.state.$([]);
      return;
    }
    this.queue.hidden = false;
    const header = document.createElement("header");
    header.textContent = `NEXT MESSAGE · ${this.items.size}`;
    const pasteButton = document.createElement("button");
    pasteButton.type = "button";
    pasteButton.textContent = "Paste into prompt";
    pasteButton.addEventListener("click", () => {
      const text = formatQueuedContext([...this.items.values()]);
      if (text) this.paste(text);
      this.items.clear();
      this.renderQueue();
      this.paintSelections();
    });
    header.appendChild(pasteButton);
    this.queue.appendChild(header);
    for (const item of this.items.values()) {
      const row = document.createElement("label");
      row.dataset.contextId = item.id;
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = item.enabled;
      enabled.addEventListener("change", () => {
        item.enabled = enabled.checked;
        this.state.$([...this.items.values()]);
      });
      const textbox = document.createElement("textarea");
      textbox.value = item.text;
      textbox.rows = 2;
      textbox.addEventListener("input", () => {
        item.text = textbox.value;
        this.state.$([...this.items.values()]);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        this.items.delete(item.id);
        this.renderQueue();
        this.paintSelections();
      });
      row.append(enabled, textbox, remove);
      this.queue.appendChild(row);
    }
    this.state.$([...this.items.values()]);
  }

  dispose() {
    this.selectionListener?.dispose();
    this.selectionListener = null;
    this.projectionSubscription.unsubscribe();
    this.anchorSubscription.unsubscribe();
    this.lifetime.unsubscribe();
    if (this.revealFrame) cancelAnimationFrame(this.revealFrame);
    this.checkboxes.clear();
    this.paintedLineIds.clear();
    this.root.remove();
  }
}
