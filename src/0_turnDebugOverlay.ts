import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Subscription } from "rxjs";
import { regionAtBufferRow, type TurnRegionKind } from "@hafley66/boop-xterm";
import {
  bufferRowAtClientY,
  readRowGeometry,
  rowTop,
  shiftSpans,
  TerminalScanShift,
} from "@hafley66/boop-xterm";
import type { TurnVisibilityModel, VisibleTurn } from "@hafley66/boop-xterm";
// Type only: the card reaches `favorites` and through it the app's DOM modules,
// and this overlay is imported by pure node unit tests (`rowTags`, `turnHue`,
// `shiftSpans`), so the class is loaded when a reader first clicks a row.
import type { TurnPanel } from "./1_turnPanel";

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
  /** The turn card a row opens, made on the first click and kept: it is placed
   *  from that click and never moved, so it is not rebuilt per frame. */
  panel: TurnPanel | null = null;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TurnVisibilityModel, "state" | "changes">,
  ) {
    this.root.className = "term-turn-debug";
    host.appendChild(this.root);
    this.scan = new TerminalScanShift(term);
    this.subscription = projection.changes.$.subscribe(() => {
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
      shiftSpans(this.projection.state.visible.$(), this.bufferShift()),
      geometry.viewportY,
      geometry.rows,
      this.pointerRow,
    );
    while (this.nodes.length > tags.length) this.nodes.pop()?.remove();
    while (this.nodes.length < tags.length) {
      const node = document.createElement("div");
      node.className = "term-turn-debug-row";
      // The layer is pointer-transparent so the terminal keeps its own mouse; a
      // row is the exception, since clicking one is how a turn's card opens.
      node.style.pointerEvents = "auto";
      node.addEventListener("click", (event) => { void this.openPanel(node, event); });
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

  /** One turn's card, opened from the row that carries it. The row names its
   *  turn id; the turn itself comes from the projection those rows were
   *  labelled from, so the card shows the text the rows drew. */
  async openPanel(row: HTMLElement, event: MouseEvent) {
    const id = row.dataset.turnId ?? "";
    if (!id) return;
    const turn = this.projection.state.visible.$().find((candidate) => candidate.id === id) ?? null;
    // A row whose turn left the projection between the paint and the click still
    // carries its number, and every turn this overlay draws belongs to the pane's
    // one session. A row with neither cannot name a source, so it opens nothing.
    const session = turn?.session ?? this.projection.state.visible.$()[0]?.session ?? "";
    const number = turn ? turn.turn : Number(row.dataset.turn);
    if (!session || !number) return;
    const source = `turn:${session}:${number}`;
    // The header the strip's own card wears (`label` in 1_agentSquaresModel), so
    // both entry points read alike. A row with no turn behind it falls back to
    // the text the row drew, timestamp and all missing.
    const when = turn
      ? new Date(turn.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const at = turn ? `${turn.role} · turn ${turn.turn} · ${when}` : row.textContent ?? "";
    const preview = turn ? turn.said : row.textContent ?? "";
    // The turn itself, so the star writes the row the overlay already holds
    // rather than reading the session's recent window back for it.
    const payload = turn
      ? {
          session: turn.session,
          harness: turn.harness,
          turn: turn.turn,
          ts: turn.ts,
          role: turn.role,
          said: turn.said,
        }
      : undefined;
    // The click point in the pane's own coordinates, read before the load below
    // so the card opens where the reader clicked and not where the pointer ended.
    const box = this.host.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    // Loaded here rather than at the top of the file: the card reaches
    // `favorites`, whose graph reads localStorage through the app's persisted
    // settings, and this module is imported by node-environment unit tests that
    // stub no globals (`0_turnDebugOverlay.test.ts`). One click deep, and the
    // module is cached after the first.
    const { cachedMarks, TurnPanel } = await import("./1_turnPanel");
    if (!this.panel) this.panel = new TurnPanel(this.host);
    this.panel.open({ id, source, at, preview, marks: cachedMarks(source), turn: payload, x, y });
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.subscription.unsubscribe();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.nodes.length = 0;
    this.root.remove();
    this.panel?.dispose();
    this.panel = null;
  }
}
