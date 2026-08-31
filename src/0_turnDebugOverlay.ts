import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { Subscription } from "rxjs";
import { regionAtBufferRow, type TurnRegionKind } from "./00_terminalTurnRegions";
import type { TerminalTurnVisibilityV2, VisibleTurn } from "./0_terminalTurnVisibility";

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

function tagLabel(turn: VisibleTurn): string {
  const role = (turn.role[0] ?? "?").toLowerCase();
  const confidence = (turn.confidence[0] ?? "?").toUpperCase();
  return `t${turn.turn} ${role} ${confidence}`;
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
    tags.push({
      bufferRow,
      viewportRow: index,
      turnId: turn?.id ?? null,
      turn: turn?.turn ?? null,
      role: turn?.role ?? "",
      confidence: turn?.confidence ?? null,
      label: turn ? tagLabel(turn) : "·",
      hue: turn ? turnHue(turn.id) : 0,
      spanStart: !!turn && turn.bufferStart === bufferRow,
      spanEnd: !!turn && turn.bufferEnd === bufferRow,
      regionKind: region?.kind ?? null,
      pointer: pointerRow === bufferRow,
    });
  }
  return tags;
}

/// A span holds absolute buffer rows from the scan that produced it. Once
/// scrollback is full xterm trims one line per line written, sliding every row
/// under a projection that has not rescanned yet.
export function shiftSpans(visible: VisibleTurn[], shift: number): VisibleTurn[] {
  if (!shift) return visible;
  return visible.map((turn) => ({
    ...turn,
    bufferStart: turn.bufferStart - shift,
    bufferEnd: turn.bufferEnd - shift,
    anchorStart: turn.anchorStart - shift,
    anchorEnd: turn.anchorEnd - shift,
    regions: turn.regions.map((region) => ({
      ...region,
      bufferStart: region.bufferStart - shift,
      bufferEnd: region.bufferEnd - shift,
    })),
  }));
}

export class TerminalTurnDebugOverlay {
  root = document.createElement("div");
  nodes: HTMLDivElement[] = [];
  disposables: IDisposable[];
  subscription: Subscription;
  frame = 0;
  pointerRow: number | null = null;
  scanMarker: IMarker | undefined;
  scanLine = 0;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
  ) {
    this.root.className = "term-turn-debug";
    host.appendChild(this.root);
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
      { dispose: () => this.scanMarker?.dispose() },
    ];
    this.markScan();
    this.schedule();
  }

  /// Pin the row the newest projection was measured against. xterm keeps a
  /// marker's `line` correct as scrollback trims, so the gap between the two
  /// is how far every span has slid.
  markScan() {
    this.scanMarker?.dispose();
    this.scanMarker = this.term.registerMarker(0);
    this.scanLine = this.scanMarker?.line ?? 0;
  }

  bufferShift(): number {
    const marker = this.scanMarker;
    if (!marker || marker.line < 0) return 0;
    return this.scanLine - marker.line;
  }

  screen(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(".xterm-screen");
  }

  bufferRowAtClientY(clientY: number): number | null {
    const screen = this.screen();
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) return null;
    const viewportRow = Math.min(
      this.term.rows - 1,
      Math.max(0, Math.floor((clientY - rect.top) / (rect.height / this.term.rows || 1))),
    );
    return this.term.buffer.active.viewportY + viewportRow;
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint() {
    const screen = this.screen();
    if (!screen) return;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows || 0;
    const left = screenRect.left - hostRect.left;
    const top = screenRect.top - hostRect.top;
    const tags = rowTags(
      shiftSpans(this.projection.visible, this.bufferShift()),
      this.term.buffer.active.viewportY,
      this.term.rows,
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
      node.style.left = `${left}px`;
      node.style.top = `${top + index * cellHeight}px`;
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
