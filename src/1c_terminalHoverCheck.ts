import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import {
  gutterLeft,
  readRowGeometry,
  rowTop,
  type TerminalRowGeometry,
} from "./0_terminalRowGeometry";
import { turnsAcrossRange, type TerminalContextQueue } from "./1a_terminalContextQueue";
import { gutter_check_px, gutter_offset_px, type GutterPaint } from "./1a2_terminalContextGutter";

export { gutter_offset_px };

/// The queue id a hover-taken line carries; one per logical line, so a second
/// click on the same line unchecks rather than queues a duplicate.
export const hoverLineId = (line: VisibleTerminalLine) => `line:${line.id}`;

/// The logical line a hover checkbox on `bufferRow` would queue. A blank line
/// queues nothing, so no checkbox is offered for it.
export function hoverTargetAt(lines: VisibleTerminalLine[], bufferRow: number): VisibleTerminalLine | null {
  const line = lines.find((candidate) => candidate.bufferStart <= bufferRow && bufferRow <= candidate.bufferEnd);
  return line && line.text.trim() ? line : null;
}

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
  private follow = (paint: GutterPaint) => this.evaluate(paint.geometry);

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
    // Repositioned inside the paint the structured boxes were placed by.
    queue.gutterPaint.followers.add(this.follow);
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

  evaluate(geometry = readRowGeometry(this.queue.term, this.queue.host)) {
    const pointer = this.pointer;
    if (!pointer || !geometry || !this.queue.enabled()) return this.hide();
    // A pane flush against its left edge has no room for a gutter, so the
    // column sits over the first cells: never summon a box under the pointer.
    const column = geometry.screen.left - geometry.left + gutterLeft(geometry, gutter_offset_px);
    if (pointer.x >= column && pointer.x < column + gutter_check_px) return;
    const row = screenRowAt(geometry.screen, geometry.rows, pointer.x, pointer.y);
    if (row === null) return this.hide();
    const line = hoverTargetAt(this.queue.anchors.visible.$(), geometry.viewportY + row);
    if (!line || this.queue.gutterPaint.paintedLineIds.has(line.id)) return this.hide();
    this.show(line, geometry);
  }

  show(line: VisibleTerminalLine, geometry: TerminalRowGeometry) {
    this.line = line;
    Object.assign(this.check.style, {
      left: `${gutterLeft(geometry, gutter_offset_px)}px`,
      top: `${rowTop(geometry, line.bufferStart)}px`,
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
    this.queue.gutterPaint.followers.delete(this.follow);
    this.queue.host.removeEventListener("mousemove", this.onMove);
    this.queue.host.removeEventListener("mouseleave", this.onLeave);
    this.check.remove();
  }
}
