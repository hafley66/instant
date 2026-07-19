// Generic per-tab zoom. One persisted factor map (store.panelZoom, keyed by
// full dock panel id — "term:<sid>", "md:<path>", …) plus a kind registry:
// each kind declares its id prefix, factor bounds, and gesture step, and how
// the zoom is applied (declarative kinds like mdview read the store in React
// and omit onZoom; imperative kinds like xterm refit in onZoom). ⌘+/-/0 route
// through panelZoomGesture: the injected resolver (owned by terminal.ts,
// which tracks keyboard focus) names the target panel; anything without a
// registered kind falls through to the whole-webview chrome zoom — so adding
// zoom to a new panel kind is a one-line registerZoomKind, not new plumbing.
import { store } from "./state";
import { nudgeZoom, resetZoom } from "./overlay";

export interface ZoomKind {
  prefix: string; // dock panel id prefix ("term:", "md:")
  min: number;
  max: number;
  step: number; // factor change per gesture tick
  onZoom?: (pid: string, factor: number) => void;
}

const kinds: ZoomKind[] = [];

export function registerZoomKind(k: ZoomKind): void {
  if (!kinds.some((x) => x.prefix === k.prefix)) kinds.push(k);
}

export function zoomFactorFor(pid: string): number {
  return store.get().panelZoom[pid] ?? 1;
}

function kindFor(pid: string): ZoomKind | undefined {
  return kinds.find((k) => pid.startsWith(k.prefix));
}

const DEFAULT_MIN = 0.3;
const DEFAULT_MAX = 3;

export function setPanelZoom(pid: string, factor: number): void {
  const k = kindFor(pid);
  const clamped = Math.min(k?.max ?? DEFAULT_MAX, Math.max(k?.min ?? DEFAULT_MIN, factor));
  store.set({ panelZoom: { ...store.get().panelZoom, [pid]: clamped } });
  k?.onZoom?.(pid, clamped);
}

export function resetPanelZoom(pid: string): void {
  const next = { ...store.get().panelZoom };
  delete next[pid];
  store.set({ panelZoom: next });
  kindFor(pid)?.onZoom?.(pid, 1);
}

// Injected at boot: focused terminal wins, else the active dock panel.
// Kept as an injection so this module imports neither terminal.ts nor
// reactdock.tsx (both would be import cycles).
let resolveTarget: () => string | null = () => null;
export function setZoomTargetResolver(fn: () => string | null): void {
  resolveTarget = fn;
}

export function panelZoomGesture(delta: number): void {
  const pid = resolveTarget();
  const k = pid ? kindFor(pid) : undefined;
  if (pid && k) setPanelZoom(pid, zoomFactorFor(pid) + k.step * Math.sign(delta));
  else nudgeZoom(delta);
}

export function panelZoomResetGesture(): void {
  const pid = resolveTarget();
  if (pid && kindFor(pid)) resetPanelZoom(pid);
  else resetZoom();
}
