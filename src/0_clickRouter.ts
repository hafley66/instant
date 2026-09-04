import { Subject } from "rxjs";

export type CmdClickSource = "terminal" | "preview" | "results" | "markdown" | "diagram" | "unknown";

export type CmdClickRequest = {
  token: string;
  cwd: string;
  source: CmdClickSource;
  /** The pane's agent session ids; the resolver checks what they touched first. */
  sessions?: string[];
};

export type CmdClickRoute = {
  id: string;
  handle(request: CmdClickRequest): boolean | Promise<boolean>;
};

export type CmdClickRoutedEvent = CmdClickRequest & { routeId: string | null };

export type CmdClickPointerInput = {
  pointerId: number;
  x: number;
  y: number;
  button: number;
  metaKey: boolean;
};

export type CmdClickGestureEvent = CmdClickPointerInput & {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  token: string;
  dragged: boolean;
};

type ActiveGesture = CmdClickPointerInput & { token: string; dragged: boolean };

export class CmdClickGestureTracker {
  readonly events = new Subject<CmdClickGestureEvent>();
  active: ActiveGesture | null = null;

  pointerDown(input: CmdClickPointerInput, token: string): boolean {
    if (input.button !== 0 || !input.metaKey || !token.trim()) return false;
    this.active = { ...input, token: token.trim(), dragged: false };
    this.emit("pointerdown", input);
    return true;
  }

  pointerMove(input: CmdClickPointerInput) {
    if (!this.active || input.pointerId !== this.active.pointerId) return;
    if (Math.hypot(input.x - this.active.x, input.y - this.active.y) > 4) this.active.dragged = true;
    this.emit("pointermove", input);
  }

  pointerUp(input: CmdClickPointerInput): string | null {
    const active = this.active;
    if (!active || input.pointerId !== active.pointerId) return null;
    this.emit("pointerup", input);
    this.active = null;
    return active.dragged ? null : active.token;
  }

  pointerCancel(input: CmdClickPointerInput) {
    if (!this.active || input.pointerId !== this.active.pointerId) return;
    this.emit("pointercancel", input);
    this.active = null;
  }

  private emit(type: CmdClickGestureEvent["type"], input: CmdClickPointerInput) {
    if (!this.active) return;
    this.events.next({ ...input, type, token: this.active.token, dragged: this.active.dragged });
  }

  dispose() {
    this.active = null;
    this.events.complete();
  }
}

export class CmdClickRouter {
  readonly routed = new Subject<CmdClickRoutedEvent>();
  readonly gestures = new Subject<CmdClickGestureEvent>();
  routes: CmdClickRoute[] = [];

  register(route: CmdClickRoute) {
    this.routes.push(route);
    return { dispose: () => this.unregister(route.id) };
  }

  unregister(id: string) {
    const index = this.routes.findIndex((route) => route.id === id);
    if (index >= 0) this.routes.splice(index, 1);
  }

  async dispatch(request: CmdClickRequest): Promise<string | null> {
    const normalized = { ...request, token: request.token.trim() };
    if (!normalized.token) return null;
    for (const route of this.routes) {
      if (!await route.handle(normalized)) continue;
      this.routed.next({ ...normalized, routeId: route.id });
      return route.id;
    }
    this.routed.next({ ...normalized, routeId: null });
    return null;
  }
}
