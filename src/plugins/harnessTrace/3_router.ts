// Per-terminal internal router (CONTRACT3): an in-memory stack of views per
// terminal sid. Clicking a row in a terminal's in-tab strip pushes an
// agent-session view; the back button pops it. No persistence and no rxjs: a
// React component subscribes and re-renders on any mutation.
import type { ITermRouter, TermView } from "./0_types";

export class TermRouter implements ITermRouter {
  private stacks = new Map<string, TermView[]>();
  private listeners = new Set<() => void>();

  push(sid: string, view: TermView): void {
    this.stacks.set(sid, [...(this.stacks.get(sid) ?? []), view]);
    this.emit();
  }

  back(sid: string): TermView | null {
    const stack = this.stacks.get(sid);
    if (!stack || stack.length === 0) return null;
    const poppedTop = stack[stack.length - 1];
    const remaining = stack.slice(0, -1);
    if (remaining.length) this.stacks.set(sid, remaining);
    else this.stacks.delete(sid);
    this.emit();
    return poppedTop;
  }

  current(sid: string): TermView | null {
    const stack = this.stacks.get(sid);
    return stack && stack.length ? stack[stack.length - 1] : null;
  }

  canGoBack(sid: string): boolean {
    return (this.stacks.get(sid)?.length ?? 0) > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

// The one router instance the in-tab strips share; per-terminal state lives in
// the keyed stacks, so one instance serves every tab.
export const termRouter: ITermRouter = new TermRouter();
