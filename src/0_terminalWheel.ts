import type { Terminal } from "@xterm/xterm";
import { BehaviorSubject, Subject, scan, type Subscription } from "rxjs";

export type TerminalMouseMode = Terminal["modes"]["mouseTrackingMode"];

export type TerminalWheelState = {
  mouseMode: TerminalMouseMode;
  native: boolean;
  wheels: number;
};

export type TerminalWheelEvent =
  | { type: "sync"; mouseMode: TerminalMouseMode }
  | { type: "wheel"; mouseMode: TerminalMouseMode };

export const initialTerminalWheelState: TerminalWheelState = {
  mouseMode: "none",
  native: false,
  wheels: 0,
};

export function reduceTerminalWheel(
  state: TerminalWheelState,
  event: TerminalWheelEvent,
): TerminalWheelState {
  return {
    mouseMode: event.mouseMode,
    native: event.mouseMode !== "none",
    wheels: state.wheels + (event.type === "wheel" ? 1 : 0),
  };
}

export class TerminalWheelRouter {
  events = new Subject<TerminalWheelEvent>();
  state = new BehaviorSubject<TerminalWheelState>(initialTerminalWheelState);
  subscription: Subscription;
  parsed: { dispose(): void };
  wheelRows = 0;
  wheelFrame = 0;

  constructor(
    readonly term: Terminal,
    readonly scrollTmux: (up: boolean, lines: number) => void,
    readonly activity: () => void,
  ) {
    this.subscription = this.events.pipe(
      scan(reduceTerminalWheel, initialTerminalWheelState),
    ).subscribe(this.state);
    this.parsed = term.onWriteParsed(() => this.sync());
    term.attachCustomWheelEventHandler((event) => this.wheel(event));
    this.sync();
  }

  sync() {
    this.events.next({ type: "sync", mouseMode: this.term.modes.mouseTrackingMode });
  }

  wheel(event: WheelEvent): boolean {
    const mouseMode = this.term.modes.mouseTrackingMode;
    this.events.next({ type: "wheel", mouseMode });
    this.activity();
    if (mouseMode !== "none") return true;

    event.preventDefault();
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    const cellHeight = screen ? screen.getBoundingClientRect().height / this.term.rows : 1;
    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
      ? event.deltaY
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * cellHeight
        : event.deltaY * cellHeight * this.term.rows;
    this.wheelRows += pixels / Math.max(1, cellHeight);
    if (!this.wheelFrame) {
      this.wheelFrame = requestAnimationFrame(() => {
        this.wheelFrame = 0;
        const rows = this.wheelRows;
        this.wheelRows = 0;
        if (rows) this.scrollTmux(rows < 0, Math.min(50, Math.max(1, Math.round(Math.abs(rows)))));
      });
    }
    return false;
  }

  dispose() {
    if (this.wheelFrame) cancelAnimationFrame(this.wheelFrame);
    this.parsed.dispose();
    this.subscription.unsubscribe();
    this.events.complete();
    this.state.complete();
  }
}
