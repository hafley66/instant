import type { Terminal } from "@xterm/xterm";
import { Signal } from "@hafley66/signals";
import { Observable, Subscription, fromEvent } from "rxjs";
import type { ProjectedTurnRegion } from "./00_terminalTurnRegions";
import type { TerminalLineAnchors } from "./00b_terminalLineAnchors";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";

export type PromptContextItem = {
  id: string;
  kind: "selection" | "table";
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

function turnsAcrossRange(turns: VisibleTurn[], start: number, end: number): string[] {
  return turns
    .filter((turn) => turn.bufferEnd >= start && turn.bufferStart <= end)
    .map((turn) => turn.id);
}

function tableRegions(turns: VisibleTurn[]): Array<ProjectedTurnRegion & { kind: "table" }> {
  return turns.flatMap((turn) => turn.regions.filter(
    (region): region is ProjectedTurnRegion & { kind: "table" } => region.kind === "table",
  ));
}

export class TerminalContextQueue {
  root = document.createElement("div");
  gutter = document.createElement("div");
  selectionAction = document.createElement("button");
  queue = document.createElement("section");
  items = new Map<string, PromptContextItem>();
  selection: TerminalSelectionSnapshot | null = null;
  readonly state = Signal<PromptContextItem[]>([]);
  readonly changes: Observable<PromptContextItem[]> = this.state.$;
  projectionSubscription: Subscription;
  anchorSubscription: Subscription;
  lifetime = new Subscription();

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
    readonly anchors: TerminalLineAnchors,
    readonly paste: (text: string) => void,
  ) {
    this.root.className = "term-context-root";
    this.gutter.className = "term-context-gutter";
    this.selectionAction.className = "term-context-selection-add";
    this.selectionAction.type = "button";
    this.selectionAction.textContent = "+ next";
    this.selectionAction.hidden = true;
    this.queue.className = "term-context-queue";
    this.root.append(this.gutter, this.selectionAction, this.queue);
    host.appendChild(this.root);
    this.projectionSubscription = projection.changes.subscribe(() => this.paintTables());
    this.anchorSubscription = anchors.events.$.subscribe(() => {
      this.paintTables();
      this.positionSelectionAction();
    });
    this.lifetime.add(fromEvent<MouseEvent>(this.selectionAction, "mousedown").subscribe((event) => event.preventDefault()));
    this.lifetime.add(fromEvent(this.selectionAction, "click").subscribe(() => this.addSelection()));
    this.lifetime.add(new Observable<void>((subscriber) => {
      const registration = term.onSelectionChange(() => subscriber.next());
      return () => registration.dispose();
    }).subscribe(() => this.captureSelection()));
    this.lifetime.add(new Observable<void>((subscriber) => {
      const scroll = term.onScroll(() => subscriber.next());
      const resize = term.onResize(() => subscriber.next());
      return () => { scroll.dispose(); resize.dispose(); };
    }).subscribe(() => this.paintTables()));
    this.paintTables();
  }

  captureSelection() {
    const text = this.term.getSelection();
    const range = this.term.getSelectionPosition();
    if (!text || !range) return;
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
    this.selectionAction.hidden = true;
    this.term.clearSelection();
    this.renderQueue();
  }

  toggleTable(region: ProjectedTurnRegion & { kind: "table" }, checked: boolean) {
    if (checked) {
      this.items.set(region.id, {
        id: region.id,
        kind: "table",
        text: region.text,
        turnIds: [region.turnId],
        enabled: true,
      });
    } else {
      this.items.delete(region.id);
    }
    this.renderQueue();
  }

  paintTables() {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / this.term.cols;
    const live = new Set<string>();
    for (const region of tableRegions(this.projection.visible)) {
      if (region.bufferEnd < top || region.bufferStart > bottom) continue;
      live.add(region.id);
      const visibleRow = Math.max(top, region.bufferStart);
      const line = this.term.buffer.active.getLine(visibleRow)?.translateToString(true) ?? "";
      const wall = Math.max(0, line.search(/[|┌├└╭╰│┃]/));
      const anchor = this.anchors.elementForBufferRow(visibleRow);
      if (!anchor) continue;
      let checkbox = this.gutter.querySelector<HTMLInputElement>(`input[data-region-id="${CSS.escape(region.id)}"]`);
      if (!checkbox) {
        checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "term-context-table-check";
        checkbox.dataset.regionId = region.id;
        checkbox.title = "Add complete table to next prompt";
        checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
        checkbox.addEventListener("change", () => this.toggleTable(region, checkbox!.checked));
        this.gutter.appendChild(checkbox);
      }
      checkbox.checked = this.items.has(region.id);
      const anchorRect = anchor.getBoundingClientRect();
      Object.assign(checkbox.style, {
        left: `${Math.max(2, screenRect.left - hostRect.left + wall * cellWidth - 20)}px`,
        top: `${anchorRect.top - hostRect.top}px`,
      });
    }
    this.gutter.querySelectorAll<HTMLInputElement>("input[data-region-id]").forEach((checkbox) => {
      if (!live.has(checkbox.dataset.regionId ?? "")) checkbox.remove();
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
      this.paintTables();
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
        this.paintTables();
      });
      row.append(enabled, textbox, remove);
      this.queue.appendChild(row);
    }
    this.state.$([...this.items.values()]);
  }

  dispose() {
    this.projectionSubscription.unsubscribe();
    this.anchorSubscription.unsubscribe();
    this.lifetime.unsubscribe();
    this.root.remove();
  }
}
