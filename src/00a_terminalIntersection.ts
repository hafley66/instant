import type { Terminal } from "@xterm/xterm";
import { merge, Observable, Subject, takeUntil } from "rxjs";
import { invoke } from "./generated/native";

export type LogicalLine = { text: string; start: number; end: number };
export type ViewportChange = {
  kind: "write" | "scroll" | "resize";
  cols: number;
  rows: number;
  viewportY: number;
  bufferLength: number;
};

export interface XtermViewport {
  readonly changes: Observable<ViewportChange>;
  readVisibleLogicalLines(): LogicalLine[];
  bufferRowAtClientY(clientY: number): number | null;
  dispose(): void;
}

export class XtermViewportAdapter implements XtermViewport {
  closed = new Subject<void>();
  changes: Observable<ViewportChange>;

  constructor(readonly term: Terminal) {
    const event = (kind: ViewportChange["kind"]) => ({
      kind,
      cols: term.cols,
      rows: term.rows,
      viewportY: term.buffer.active.viewportY,
      bufferLength: term.buffer.active.length,
    });
    const xtermEvent = (kind: ViewportChange["kind"], register: (emit: () => void) => { dispose(): void }) =>
      new Observable<ViewportChange>((subscriber) => {
        const registration = register(() => subscriber.next(event(kind)));
        return () => registration.dispose();
      });
    this.changes = merge(
      xtermEvent("write", (emit) => term.onWriteParsed(emit)),
      xtermEvent("scroll", (emit) => term.onScroll(emit)),
      xtermEvent("resize", (emit) => term.onResize(emit)),
    ).pipe(takeUntil(this.closed));
  }

  readVisibleLogicalLines(): LogicalLine[] {
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    const end = Math.min(buffer.length - 1, top + this.term.rows - 1);
    const lines: LogicalLine[] = [];
    let current: LogicalLine | null = null;
    for (let row = top; row <= end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const continued = buffer.getLine(row + 1)?.isWrapped ?? false;
      const text = line.translateToString(!continued);
      if (line.isWrapped && current) {
        current.text += text;
        current.end = row;
      } else {
        current = { text, start: row, end: row };
        lines.push(current);
      }
    }
    return lines;
  }

  bufferRowAtClientY(clientY: number): number | null {
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) return null;
    const viewportRow = Math.min(
      this.term.rows - 1,
      Math.max(0, Math.floor((clientY - rect.top) / (rect.height / this.term.rows || 1))),
    );
    return this.term.buffer.active.viewportY + viewportRow;
  }

  dispose() {
    this.closed.next();
    this.closed.complete();
  }
}

export interface TmuxPane {
  readonly target: string;
  captureVisible(): Promise<string>;
}

export class NativeTmuxPane implements TmuxPane {
  session_id: string | null = null;
  session_read_at = Number.NEGATIVE_INFINITY;
  constructor(readonly target: string, readonly socket?: string) {}

  captureVisible(): Promise<string> {
    return invoke<string>("boop_mux_capture", { target: this.target, socket: this.socket ?? null });
  }

  async session(): Promise<string | null> {
    if (performance.now() - this.session_read_at < 1000) return this.session_id;
    this.session_id = await invoke<string | null>("boop_mux_session", {
      target: this.target, socket: this.socket ?? null,
    }).catch(() => null);
    this.session_read_at = performance.now();
    return this.session_id;
  }
}

export type BoopFavorite = {
  favorite_id: number;
  note: string;
  source: string;
  created_ts: number;
  bytes: number;
  body: string;
};

export interface BoopConversation<TTurn> {
  readonly session: string;
  turns(): Promise<TTurn[]>;
  favorites(): Promise<BoopFavorite[]>;
  toggleFavorite(turn: TTurn): Promise<BoopFavorite[]>;
}
