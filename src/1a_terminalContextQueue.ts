import type { Terminal } from "@xterm/xterm";
import { Signal } from "@hafley66/signals";
import { Observable, Subject } from "rxjs";
import type { TerminalLineAnchors } from "./00b_terminalLineAnchors";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";
import { turnHue } from "./0_turnDebugOverlay";
import { TerminalContextGutter, type StructuredSelectable } from "./1a2_terminalContextGutter";

export type PromptContextItem = {
  id: string;
  /// `selection`: a range the reader picked; `table`/`list`/`heading`: a
  /// structured row taken by its gutter checkbox; `line`: one logical line
  /// taken by the hover checkbox.
  kind: "selection" | "table" | "list" | "heading" | "line";
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

export class TerminalContextQueue {
  root = document.createElement("div");
  gutter = document.createElement("div");
  queue = document.createElement("section");
  items = new Map<string, PromptContextItem>();
  /// Owns every checkbox in the gutter and the frame they are painted on.
  readonly gutterPaint: TerminalContextGutter;
  readonly state = Signal<PromptContextItem[]>([]);
  readonly changes: Observable<PromptContextItem[]> = this.state.$;
  /// Item ids delivered into a prompt by Send, emitted before the queue
  /// clears, so a sync layer marks them sent instead of deleted.
  readonly sent = new Subject<string[]>();

  /// Why the last Send kept its rows, shown in the header until a send lands.
  sendError: string | null = null;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
    readonly anchors: TerminalLineAnchors,
    /// Resolves once the pty took the body; a rejection keeps the queue.
    readonly paste: (text: string) => Promise<void> | void,
    readonly enabled: () => boolean,
  ) {
    this.root.className = "term-context-root";
    this.gutter.className = "term-context-gutter";
    this.queue.className = "term-context-queue";
    this.queue.hidden = true;
    this.root.append(this.gutter, this.queue);
    host.appendChild(this.root);
    this.gutterPaint = new TerminalContextGutter(this);
  }

  /// Queue a slice for the next message. The caller names it outright: the
  /// right-click menu is the only way in, and it reads whichever selection is
  /// live (xterm's own, or the pinned overlay's on a pane whose app owns the
  /// mouse and where xterm therefore makes none).
  addSelection(
    snapshot: Pick<TerminalSelectionSnapshot, "text" | "turnIds"> & {
      id?: string;
      kind?: PromptContextItem["kind"];
      note?: string;
    },
  ): string | null {
    if (!snapshot.text) return null;
    const source = snapshot;
    const id = source.id ?? `selection:${Date.now()}:${this.items.size}`;
    this.items.set(id, {
      id,
      kind: source.kind ?? "selection",
      text: source.text,
      note: source.note,
      turnIds: source.turnIds,
      enabled: true,
    });
    this.term.clearSelection();
    this.renderQueue();
    return id;
  }

  /// Send the queue as one prompt body. The rows clear only once the pty took
  /// the write; a failed write keeps every row and says why in the header, so
  /// a note typed at length is never gone with nothing to show for it. `sent`
  /// fires before the clear, so the sync layer flushes the final text and
  /// stamps the rows sent rather than deleted.
  async send(): Promise<boolean> {
    const items = [...this.items.values()];
    const text = formatQueuedContext(items);
    if (!text) return false;
    this.sendError = null;
    this.queue.dataset.sending = "true";
    try {
      await this.paste(text);
    } catch (error) {
      this.sendError = error instanceof Error ? error.message : String(error);
      delete this.queue.dataset.sending;
      this.renderQueue();
      return false;
    }
    delete this.queue.dataset.sending;
    this.sent.next(items.map((item) => item.id));
    this.items.clear();
    this.renderQueue();
    this.paintSelections();
    return true;
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

  activate() {
    this.anchors.refresh();
    this.gutterPaint.schedule();
  }

  /// Repaint the gutter on the next frame. Kept as the name the terminal's
  /// wiring already calls; the painter decides what moves.
  paintSelections() {
    this.gutterPaint.schedule();
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
      this.sendError = null;
      this.state.$([]);
      return;
    }
    this.queue.hidden = false;
    const header = document.createElement("header");
    const title = document.createElement("span");
    title.className = "term-context-queue-title";
    title.textContent = `NEXT MESSAGE · ${this.items.size}`;
    header.appendChild(title);
    if (this.sendError) {
      const status = document.createElement("span");
      status.className = "term-context-queue-status";
      status.textContent = `send failed, kept: ${this.sendError}`;
      status.title = this.sendError;
      header.appendChild(status);
    }
    const pasteButton = document.createElement("button");
    pasteButton.type = "button";
    pasteButton.textContent = "Send";
    pasteButton.addEventListener("click", () => {
      pasteButton.disabled = true;
      pasteButton.textContent = "Sending…";
      void this.send().then((landed) => {
        if (landed || !pasteButton.isConnected) return;
        pasteButton.disabled = false;
        pasteButton.textContent = "Send";
      });
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
    this.gutterPaint.dispose();
    this.root.remove();
  }
}
