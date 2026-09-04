import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Subscription } from "rxjs";
import { regionAtBufferRow, type TurnRegionKind } from "./00_terminalTurnRegions";
import {
  bufferRowAtClientY,
  readRowGeometry,
  rowTop,
  shiftSpans,
  TerminalScanShift,
} from "./0_terminalRowGeometry";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";

export { shiftSpans };

export type RowTag = {
  bufferRow: number;
  /** Offset from the first painted row, so the caller never re-derives it. */
  viewportRow: number;
  turnId: string | null;
  turn: number | null;
  role: string;
  confidence: VisibleTurn["confidence"] | null;
  label: string;
  hue: number;
  spanStart: boolean;
  spanEnd: boolean;
  regionKind: TurnRegionKind | null;
  pointer: boolean;
};

/** Stable turn id -> hue, so one turn keeps one colour across repaints and
 *  neighbouring turn numbers land far apart on the wheel. */
export function turnHue(turnId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < turnId.length; index++) {
    hash ^= turnId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) * 137) % 360;
}

function tagLabel(turn: VisibleTurn, spanStart: boolean, spanEnd: boolean): string {
  const confidence = (turn.confidence[0] ?? "?").toUpperCase();
  const edge = spanStart
    ? turn.clippedAbove ? "↑" : spanEnd ? "◆" : "┌"
    : spanEnd
      ? turn.clippedBelow ? "↓" : "└"
      : "│";
  return `${edge} t${turn.turn} ${turn.role} ${confidence}`;
}

/** What every visible row is attributed to. Pure: the DOM layer in
 *  TerminalTurnDebugOverlay renders these and computes nothing of its own. */
export function rowTags(
  visible: VisibleTurn[],
  firstRow: number,
  rows: number,
  pointerRow: number | null,
): RowTag[] {
  const tags: RowTag[] = [];
  for (let index = 0; index < rows; index++) {
    const bufferRow = firstRow + index;
    const turn = visible.find((candidate) =>
      candidate.bufferStart <= bufferRow && bufferRow <= candidate.bufferEnd) ?? null;
    const region = turn ? regionAtBufferRow(turn.regions, bufferRow) : null;
    const spanStart = !!turn && turn.bufferStart === bufferRow;
    const spanEnd = !!turn && turn.bufferEnd === bufferRow;
    tags.push({
      bufferRow,
      viewportRow: index,
      turnId: turn?.id ?? null,
      turn: turn?.turn ?? null,
      role: turn?.role ?? "",
      confidence: turn?.confidence ?? null,
      label: turn ? tagLabel(turn, spanStart, spanEnd) : "·",
      hue: turn ? turnHue(turn.id) : 0,
      spanStart,
      spanEnd,
      regionKind: region?.kind ?? null,
      pointer: pointerRow === bufferRow,
    });
  }
  return tags;
}

export class TerminalTurnDebugOverlay {
  root = document.createElement("div");
  nodes: HTMLDivElement[] = [];
  disposables: IDisposable[];
  subscription: Subscription;
  frame = 0;
  pointerRow: number | null = null;
  scan: TerminalScanShift;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
  ) {
    this.root.className = "term-turn-debug";
    host.appendChild(this.root);
    this.scan = new TerminalScanShift(term);
    this.subscription = projection.changes.subscribe(() => {
      this.markScan();
      this.schedule();
    });
    const onPointerMove = (event: PointerEvent) => {
      const row = this.bufferRowAtClientY(event.clientY);
      if (row === this.pointerRow) return;
      this.pointerRow = row;
      this.schedule();
    };
    const onPointerLeave = () => {
      if (this.pointerRow === null) return;
      this.pointerRow = null;
      this.schedule();
    };
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    this.disposables = [
      { dispose: () => host.removeEventListener("pointermove", onPointerMove) },
      { dispose: () => host.removeEventListener("pointerleave", onPointerLeave) },
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.onWriteParsed(() => this.schedule()),
      { dispose: () => this.scan.dispose() },
    ];
    this.markScan();
    this.schedule();
  }

  markScan() { this.scan.mark(); }

  bufferShift(): number { return this.scan.shift(); }

  screen(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(".xterm-screen");
  }

  bufferRowAtClientY(clientY: number): number | null {
    const geometry = readRowGeometry(this.term, this.host);
    return geometry ? bufferRowAtClientY(geometry, clientY) : null;
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint() {
    const geometry = readRowGeometry(this.term, this.host);
    if (!geometry) return;
    const cellHeight = geometry.cellHeight;
    const tags = rowTags(
      shiftSpans(this.projection.visible, this.bufferShift()),
      geometry.viewportY,
      geometry.rows,
      this.pointerRow,
    );
    while (this.nodes.length > tags.length) this.nodes.pop()?.remove();
    while (this.nodes.length < tags.length) {
      const node = document.createElement("div");
      node.className = "term-turn-debug-row";
      this.root.appendChild(node);
      this.nodes.push(node);
    }
    for (let index = 0; index < tags.length; index++) {
      const tag = tags[index];
      const node = this.nodes[index];
      if (node.textContent !== tag.label) node.textContent = tag.label;
      node.dataset.bufferRow = String(tag.bufferRow);
      node.dataset.turnId = tag.turnId ?? "";
      node.dataset.turn = tag.turn === null ? "" : String(tag.turn);
      node.dataset.role = tag.role;
      node.dataset.confidence = tag.confidence ?? "";
      node.dataset.span = tag.spanStart && tag.spanEnd
        ? "single"
        : tag.spanStart ? "start" : tag.spanEnd ? "end" : "body";
      node.style.left = "";
      node.style.right = `${geometry.right}px`;
      node.style.top = `${rowTop(geometry, tag.bufferRow)}px`;
      node.style.height = `${cellHeight}px`;
      node.style.lineHeight = `${cellHeight}px`;
      node.style.color = tag.turnId
        ? `hsl(${tag.hue} ${tag.pointer ? 100 : 75}% ${tag.pointer ? 82 : 62}%)`
        : "rgba(150, 150, 150, 0.45)";
      node.style.borderLeft = tag.turnId ? `2px solid hsl(${tag.hue} 80% 55%)` : "2px solid transparent";
      node.style.borderBottom = tag.regionKind
        ? `1px dashed hsl(${tag.hue} 70% 60%)`
        : tag.spanEnd ? `1px solid hsl(${tag.hue} 80% 55%)` : "1px solid transparent";
      node.style.borderTop = tag.spanStart ? `1px solid hsl(${tag.hue} 80% 55%)` : "1px solid transparent";
      node.style.background = tag.pointer ? "rgba(0, 0, 0, 0.45)" : "transparent";
      node.style.fontWeight = tag.pointer ? "700" : "400";
    }
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.subscription.unsubscribe();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.nodes.length = 0;
    this.root.remove();
  }
}
