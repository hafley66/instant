import { Signal, SignalCreator } from "@hafley66/signals";
import type { Terminal } from "@xterm/xterm";
import { Subscription, debounceTime } from "rxjs";
import type { XtermViewport } from "./00a_terminalIntersection";

export type VisibleTerminalLine = { id: string; bufferStart: number; bufferEnd: number; viewportStart: number; viewportEnd: number; text: string };
export type TerminalLineAnchorEvent =
  | { kind: "entered"; line: VisibleTerminalLine }
  | { kind: "moved"; line: VisibleTerminalLine; previousViewportStart: number }
  | { kind: "changed"; line: VisibleTerminalLine; previousText: string }
  | { kind: "exited"; id: string }
  | { kind: "viewport-jump"; previousTop: number; top: number }
  | { kind: "top-line-changed"; previousId: string; id: string };

function hashLine(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function terminalLineId(text: string, duplicateIndex = 0): string { return `line-${hashLine(text)}-${duplicateIndex}`; }

export class TerminalLineAnchors {
  readonly events = SignalCreator<TerminalLineAnchorEvent[]>({ event: true });
  readonly visible = Signal<VisibleTerminalLine[]>([]);
  readonly settled = Signal(true);
  elementsByBufferRow = new Map<number, HTMLElement>();
  frame = 0;
  lifetime = new Subscription();
  previousTop = 0;

  constructor(readonly term: Terminal, readonly viewport: XtermViewport) {
    // xterm's renderer replaces many nested spans for one parsed write. A DOM
    // MutationObserver here turns that renderer churn into a second render
    // loop. The terminal API already reports every semantic source of viewport
    // change: parsed writes, scrolling, and resizing.
    const activity = viewport.changes;
    this.lifetime.add(activity.subscribe(() => { this.settled.$(false); this.schedule(); }));
    this.lifetime.add(activity.pipe(debounceTime(80)).subscribe(() => { this.refresh(); this.settled.$(true); }));
    this.refresh();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh(); });
  }

  refresh() {
    const rowElements = Array.from(this.term.element?.querySelectorAll<HTMLElement>(".xterm-rows > div") ?? []);
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    const bottom = Math.min(buffer.length - 1, top + this.term.rows - 1);
    const duplicateCount = new Map<string, number>();
    const next = this.viewport.readVisibleLogicalLines().map((line) => {
      const duplicateIndex = duplicateCount.get(line.text) ?? 0;
      duplicateCount.set(line.text, duplicateIndex + 1);
      return { id: terminalLineId(line.text, duplicateIndex), bufferStart: line.start, bufferEnd: line.end,
        viewportStart: line.start - top, viewportEnd: line.end - top, text: line.text };
    });
    this.elementsByBufferRow.clear();
    for (let row = top; row <= bottom; row++) {
      const element = rowElements[row - top];
      const line = next.find((candidate) => candidate.bufferStart <= row && row <= candidate.bufferEnd);
      if (!element || !line) continue;
      element.dataset.terminalLineId = line.id;
      element.dataset.bufferRow = String(row);
      element.style.setProperty("anchor-name", `--${line.id}`);
      this.elementsByBufferRow.set(row, element);
    }
    const prior = this.visible.$();
    const before = new Map(prior.map((line) => [line.id, line]));
    const after = new Map(next.map((line) => [line.id, line]));
    const events: TerminalLineAnchorEvent[] = [];
    if (Math.abs(top - this.previousTop) > 1) events.push({ kind: "viewport-jump", previousTop: this.previousTop, top });
    if (prior[0] && next[0] && prior[0].id !== next[0].id) events.push({ kind: "top-line-changed", previousId: prior[0].id, id: next[0].id });
    for (const line of next) {
      const previous = before.get(line.id);
      if (!previous) events.push({ kind: "entered", line });
      else if (previous.text !== line.text) events.push({ kind: "changed", line, previousText: previous.text });
      else if (previous.viewportStart !== line.viewportStart) events.push({ kind: "moved", line, previousViewportStart: previous.viewportStart });
    }
    for (const line of prior) if (!after.has(line.id)) events.push({ kind: "exited", id: line.id });
    this.previousTop = top;
    const same = prior.length === next.length && prior.every((line, index) => {
      const candidate = next[index];
      return line.id === candidate.id && line.bufferStart === candidate.bufferStart &&
        line.bufferEnd === candidate.bufferEnd && line.viewportStart === candidate.viewportStart &&
        line.viewportEnd === candidate.viewportEnd && line.text === candidate.text;
    });
    if (!same) this.visible.$(next);
    if (events.length) this.events.$(events);
  }

  elementForBufferRow(row: number) { return this.elementsByBufferRow.get(row) ?? null; }
  dispose() { if (this.frame) cancelAnimationFrame(this.frame); this.lifetime.unsubscribe(); this.elementsByBufferRow.clear(); }
}
