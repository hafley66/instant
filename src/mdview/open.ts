// openMarkdownPanel: the single entry point every markdown route funnels
// through (preview interception, click-rule interception, in-viewer links).
// Kept separate from index.ts so callers don't pull the React panel into
// their module graph.
import { addMdPanel, mdPanelId } from "../reactdock";
import { baseName } from "../core";

// A #frag requested with the next open, consumed by the panel once its doc is
// ready (value "" = no frag). One-shot so reactivating an already-open panel
// doesn't re-scroll on the next unrelated render.
const pendingFrag = new Map<string, string>();

// Live-panel navigate hooks, registered by MdInstance: opening a path whose
// panel already exists steers that panel back to the path (it may have
// browsed elsewhere since it was opened).
const panelNav = new Map<string, (path: string) => void>();

export function registerMdNav(pid: string, fn: (path: string) => void): () => void {
  panelNav.set(pid, fn);
  return () => {
    if (panelNav.get(pid) === fn) panelNav.delete(pid);
  };
}

export function openMarkdownPanel(path: string, frag?: string): void {
  setPendingFrag(path, frag);
  addMdPanel(path, baseName(path));
  panelNav.get(mdPanelId(path))?.(path);
}

// In-place navigation (explorer clicks, in-doc links) uses this so a #frag is
// waiting when the target doc flips to ready — same one-shot channel as opens.
export function setPendingFrag(path: string, frag?: string): void {
  if (frag) pendingFrag.set(path, frag);
}

export function takePendingFrag(path: string): string {
  const f = pendingFrag.get(path) ?? "";
  pendingFrag.delete(path);
  return f;
}
