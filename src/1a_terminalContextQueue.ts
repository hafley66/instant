import type { Terminal } from "@xterm/xterm";
import { Signal } from "@hafley66/signals";
import { debounceTime, filter, merge, Observable, share, startWith, Subject, Subscription, switchMap, take, tap } from "rxjs";
import type { TerminalLineAnchors } from "./00b_terminalLineAnchors";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";
import { turnHue } from "./0_turnDebugOverlay";

export type PromptContextItem = {
  id: string;
  kind: "selection" | "table" | "list";
  /// The slice taken off the screen. Held as read, so the quote in the prompt
  /// is what the turn actually said.
  text: string;
  /// What the reader wants done with the slice. Kept apart from `text` so the
  /// intent is never mistaken for the quote by whoever reads the prompt.
  note?: string;
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
    const note = item.note?.trim();
    // The note is the reader's intent for the slice, so it goes under the quote
    // and says which it is; a slice with no note reads exactly as it used to.
    return note
      ? `[${source}]\n${item.text.trim()}\n\nAbout that: ${note}`
      : `[${source}]\n${item.text.trim()}`;
  }).join("\n\n")}\n\n`;
}

// Tags a selection with the turns whose own text it overlaps, never with a
// turn whose extended span merely reaches across it. Role-blind on purpose:
// a user turn is as quotable as an assistant one.
export function turnsAcrossRange(turns: VisibleTurn[], start: number, end: number): string[] {
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
  queue = document.createElement("section");
  items = new Map<string, PromptContextItem>();
  checkboxes = new Map<string, HTMLInputElement>();
  paintedLineIds = new Set<string>();
  paintDirty = true;
  revealFrame = 0;
  readonly state = Signal<PromptContextItem[]>([]);
  readonly changes: Observable<PromptContextItem[]> = this.state.$;
  /// Item ids delivered into a prompt by Send, emitted before the queue
  /// clears, so a sync layer marks them sent instead of deleted.
  readonly sent = new Subject<string[]>();
  projectionSubscription: Subscription;
  anchorSubscription: Subscription;

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
    this.queue.className = "term-context-queue";
    this.queue.hidden = true;
    this.root.append(this.gutter, this.queue);
    host.appendChild(this.root);
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

  /// Queue a slice for the next message. The caller names it outright: the
  /// right-click menu is the only way in, and it reads whichever selection is
  /// live (xterm's own, or the pinned overlay's on a pane whose app owns the
  /// mouse and where xterm therefore makes none).
  addSelection(snapshot: Pick<TerminalSelectionSnapshot, "text" | "turnIds">): string | null {
    if (!snapshot.text) return null;
    const source = snapshot;
    const id = `selection:${Date.now()}:${this.items.size}`;
    this.items.set(id, {
      id,
      kind: "selection",
      text: source.text,
      turnIds: source.turnIds,
      enabled: true,
    });
    this.term.clearSelection();
    this.renderQueue();
    return id;
  }

  /// Rows read back from the store. An id already present locally wins: under
  /// write-through the local copy is at least as new as the stored one.
  hydrate(items: PromptContextItem[]) {
    let changed = false;
    for (const item of items) {
      if (this.items.has(item.id)) continue;
      this.items.set(item.id, item);
      changed = true;
    }
    if (changed) {
      this.renderQueue();
      this.paintSelections();
    }
  }

  /// Put the caret in a queued slice's note, so "Ask about this" types straight
  /// into "what you want done with this…" without a click.
  focusNote(id: string) {
    this.queue
      .querySelector<HTMLTextAreaElement>(`[data-context-id="${CSS.escape(id)}"] textarea`)
      ?.focus();
  }

  /// The buffer rows a pinned selection covers, tagged with the turns whose own
  /// text it overlaps, so a queued pinned selection reads the same as one xterm
  /// made.
  snapshotFor(text: string, startRow: number, endRow: number): Pick<TerminalSelectionSnapshot, "text" | "turnIds"> {
    return { text, turnIds: turnsAcrossRange(this.projection.visible, startRow, endRow) };
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

  /// One chip per turn the slice came out of, coloured with the same hue the
  /// debug overlay paints that turn with, so a queued slice reads back to the
  /// message on screen it was taken from. A slice that overlaps no turn says so
  /// rather than showing nothing.
  turnBadges(item: PromptContextItem): HTMLElement[] {
    if (!item.turnIds.length) {
      const chip = document.createElement("span");
      chip.className = "term-context-queue-turn term-context-queue-turn-none";
      chip.textContent = "terminal";
      return [chip];
    }
    return item.turnIds.map((id) => {
      const turn = this.projection.visible.find((visible) => visible.id === id);
      const chip = document.createElement("span");
      chip.className = "term-context-queue-turn";
      chip.dataset.turnId = id;
      chip.textContent = turn
        ? `t${turn.turn} ${turn.role}`
        : `t${id.slice(id.lastIndexOf(":") + 1)}`;
      chip.title = id;
      const hue = turnHue(id);
      chip.style.color = `hsl(${hue} 75% 72%)`;
      chip.style.borderColor = `hsl(${hue} 70% 46%)`;
      return chip;
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
    const title = document.createElement("span");
    title.className = "term-context-queue-title";
    title.textContent = `NEXT MESSAGE · ${this.items.size}`;
    header.appendChild(title);
    const pasteButton = document.createElement("button");
    pasteButton.type = "button";
    pasteButton.textContent = "Send";
    pasteButton.addEventListener("click", () => {
      const text = formatQueuedContext([...this.items.values()]);
      if (text) this.paste(text);
      this.sent.next([...this.items.keys()]);
      this.items.clear();
      this.renderQueue();
      this.paintSelections();
    });
    header.appendChild(pasteButton);
    this.queue.appendChild(header);
    for (const item of this.items.values()) {
      const row = document.createElement("div");
      row.className = "term-context-queue-item";
      row.dataset.contextId = item.id;

      const top = document.createElement("div");
      top.className = "term-context-queue-meta";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = item.enabled;
      enabled.addEventListener("change", () => {
        item.enabled = enabled.checked;
        row.dataset.disabled = String(!enabled.checked);
        this.state.$([...this.items.values()]);
      });
      row.dataset.disabled = String(!item.enabled);
      top.appendChild(enabled);
      for (const badge of this.turnBadges(item)) top.appendChild(badge);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "term-context-queue-remove";
      remove.title = "drop this slice";
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        this.items.delete(item.id);
        this.renderQueue();
        this.paintSelections();
      });
      top.appendChild(remove);

      const quote = document.createElement("pre");
      quote.className = "term-context-queue-quote";
      quote.textContent = item.text;

      const textbox = document.createElement("textarea");
      textbox.className = "term-context-queue-note";
      textbox.value = item.note ?? "";
      textbox.rows = 2;
      textbox.placeholder = "what you want done with this…";
      textbox.addEventListener("input", () => {
        item.note = textbox.value;
        this.state.$([...this.items.values()]);
      });

      row.append(top, quote, textbox);
      this.queue.appendChild(row);
    }
    this.state.$([...this.items.values()]);
  }

  dispose() {
    this.projectionSubscription.unsubscribe();
    this.anchorSubscription.unsubscribe();
    if (this.revealFrame) cancelAnimationFrame(this.revealFrame);
    this.checkboxes.clear();
    this.paintedLineIds.clear();
    this.root.remove();
  }
}
