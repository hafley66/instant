// Generic per-tab zoom. One persisted factor map (store.panelZoom, keyed by
// full dock panel id — "term:<sid>", "md:<path>", …) plus a kind registry:
// each kind declares its id prefix, factor bounds, and gesture step, and how
// the zoom is applied (declarative kinds like mdview read the store in React
// and omit onZoom; imperative kinds like xterm refit in onZoom). ⌘+/-/0 route
// through panelZoomGesture: the injected resolver (owned by terminal.ts,
// which tracks keyboard focus) names the target panel; anything without a
// registered kind falls through to the whole-webview chrome zoom — so adding
// zoom to a new panel kind is a one-line registerZoomKind, not new plumbing.
// ./state is the only import this module may take: every other app module
// reaches reactdock/terminal, which import this one back.
import { settings } from "./0_settings";

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
  return settings.panelZoom.$()[pid] ?? 1;
}

function kindFor(pid: string): ZoomKind | undefined {
  return kinds.find((k) => pid.startsWith(k.prefix));
}

const DEFAULT_MIN = 0.3;
const DEFAULT_MAX = 3;

export function setPanelZoom(pid: string, factor: number): void {
  const k = kindFor(pid);
  const clamped = Math.min(k?.max ?? DEFAULT_MAX, Math.max(k?.min ?? DEFAULT_MIN, factor));
  settings.panelZoom.$({ ...settings.panelZoom.$(), [pid]: clamped });
  k?.onZoom?.(pid, clamped);
}

export function resetPanelZoom(pid: string): void {
  const next = { ...settings.panelZoom.$() };
  delete next[pid];
  settings.panelZoom.$(next);
  kindFor(pid)?.onZoom?.(pid, 1);
}

// Which panel a gesture zooms, given the two things that can name one: the
// dock's active panel and the terminal holding keyboard focus. Neither alone
// is the answer — a markdown preview ⌘-clicked open from a terminal becomes
// active while that terminal keeps DOM focus, and clicking back into an xterm
// does not re-activate its dock panel — so the more recently reached one wins,
// each carrying the time it was reached (same clock, performance.now()).
export interface ZoomCandidate {
  pid: string | null;
  at: number;
}
export function resolveZoomTarget(active: ZoomCandidate, focused: ZoomCandidate): string | null {
  if (focused.pid && focused.at >= active.at) return focused.pid;
  if (active.pid && kindFor(active.pid)) return active.pid;
  return focused.pid ?? active.pid;
}

// Injected at boot (terminal.ts owns both: it tracks keyboard focus and can
// read the dock). Kept as injections so this module imports neither
// terminal.ts nor reactdock.tsx nor overlay.ts (each is an import cycle back
// to here).
let resolveTarget: () => string | null = () => null;
export function setZoomTargetResolver(fn: () => string | null): void {
  resolveTarget = fn;
}

export interface ChromeZoom {
  nudge: (delta: number) => void;
  reset: () => void;
}
let chromeZoom: ChromeZoom = { nudge: () => {}, reset: () => {} };
export function setChromeZoom(fns: ChromeZoom): void {
  chromeZoom = fns;
}

export function panelZoomGesture(delta: number): void {
  const pid = resolveTarget();
  const k = pid ? kindFor(pid) : undefined;
  if (pid && k) setPanelZoom(pid, zoomFactorFor(pid) + k.step * Math.sign(delta));
  else chromeZoom.nudge(delta);
}

export function panelZoomResetGesture(): void {
  const pid = resolveTarget();
  if (pid && kindFor(pid)) resetPanelZoom(pid);
  else chromeZoom.reset();
}
