import type { Subscription } from "rxjs";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import { turnsAcrossRange, type TerminalContextQueue } from "./1a_terminalContextQueue";

/// The queue id a hover-taken line carries; one per logical line, so a second
/// click on the same line unchecks rather than queues a duplicate.
export const hoverLineId = (line: VisibleTerminalLine) => `line:${line.id}`;

/// The logical line a hover checkbox on `bufferRow` would queue. A blank line
/// queues nothing, so no checkbox is offered for it.
export function hoverTargetAt(lines: VisibleTerminalLine[], bufferRow: number): VisibleTerminalLine | null {
  const line = lines.find((candidate) => candidate.bufferStart <= bufferRow && bufferRow <= candidate.bufferEnd);
  return line && line.text.trim() ? line : null;
}

/// How far left of the screen edge the gutter checkboxes sit, matching the
/// structured checkboxes the queue paints.
export const gutter_offset_px = 42;

/// The screen row under a pointer, by geometry rather than by hit target:
/// xterm stacks selection, decoration and helper layers over its row
/// elements, so the element under the mouse is rarely the row itself.
export function screenRowAt(
  screen: { top: number; bottom: number; left: number; right: number; height: number },
  rows: number,
  x: number,
  y: number,
): number | null {
  if (rows <= 0 || y < screen.top || y >= screen.bottom) return null;
  if (x >= screen.right || x < screen.left - gutter_offset_px - 6) return null;
  return Math.min(rows - 1, Math.floor((y - screen.top) / (screen.height / rows)));
}

/// One checkbox that follows the pointer down the left gutter: whatever line
/// is under the mouse can be taken for the next prompt, structured or not. A
/// line that already carries a structured checkbox keeps that one, so the two
/// never stack on one row.
export class TerminalHoverCheck {
  readonly check = document.createElement("input");
  line: VisibleTerminalLine | null = null;
  private pointer: { x: number; y: number } | null = null;
  private anchorSubscription: Subscription;

  constructor(readonly queue: TerminalContextQueue) {
    this.check.type = "checkbox";
    this.check.className = "term-context-hover-check";
    this.check.title = "Add this line to next prompt";
    this.check.hidden = true;
    this.check.addEventListener("mousedown", (event) => event.stopPropagation());
    this.check.addEventListener("change", () => this.toggle());
    queue.gutter.appendChild(this.check);
    queue.host.addEventListener("mousemove", this.onMove);
    queue.host.addEventListener("mouseleave", this.onLeave);
    // Anchors settle after the write the pointer is already resting on.
    this.anchorSubscription = queue.anchors.visible.$.subscribe(() => this.evaluate());
  }

  private onMove = (event: MouseEvent) => {
    if (event.target === this.check) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    if (event.target instanceof Element && event.target.closest(".term-context-queue")) return this.hide();
    this.evaluate();
  };

  private onLeave = () => {
    this.pointer = null;
    this.hide();
  };

  evaluate() {
    const pointer = this.pointer;
    if (!pointer || !this.queue.enabled()) return this.hide();
    const screen = this.queue.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return this.hide();
    const row = screenRowAt(screen.getBoundingClientRect(), this.queue.term.rows, pointer.x, pointer.y);
    if (row === null) return this.hide();
    const bufferRow = this.queue.term.buffer.active.viewportY + row;
    const line = hoverTargetAt(this.queue.anchors.visible.$(), bufferRow);
    if (!line || this.queue.paintedLineIds.has(line.id)) return this.hide();
    const anchor = this.queue.anchors.elementForBufferRow(line.bufferStart);
    if (!anchor) return this.hide();
    this.show(line, anchor);
  }

  show(line: VisibleTerminalLine, anchor: HTMLElement) {
    this.line = line;
    const screen = this.queue.host.querySelector<HTMLElement>(".xterm-screen");
    const hostRect = this.queue.host.getBoundingClientRect();
    const screenRect = (screen ?? anchor).getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    Object.assign(this.check.style, {
      left: `${Math.max(2, screenRect.left - hostRect.left - gutter_offset_px)}px`,
      top: `${anchorRect.top - hostRect.top}px`,
    });
    this.check.dataset.terminalLineId = line.id;
    this.check.checked = this.queue.items.has(hoverLineId(line));
    this.check.hidden = false;
  }

  hide() {
    this.line = null;
    this.check.hidden = true;
  }

  toggle() {
    const line = this.line;
    if (!line) return;
    const id = hoverLineId(line);
    if (this.check.checked) {
      this.queue.addSelection({
        id,
        kind: "line",
        text: line.text,
        turnIds: turnsAcrossRange(this.queue.projection.visible, line.bufferStart, line.bufferEnd),
      });
      return;
    }
    this.queue.items.delete(id);
    this.queue.renderQueue();
  }

  dispose() {
    this.anchorSubscription.unsubscribe();
    this.queue.host.removeEventListener("mousemove", this.onMove);
    this.queue.host.removeEventListener("mouseleave", this.onLeave);
    this.check.remove();
  }
}
