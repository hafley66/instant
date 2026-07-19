// openMarkdownPanel: the single entry point every markdown route funnels
// through (preview interception, click-rule interception, in-viewer links).
// Kept separate from index.ts so callers don't pull the React panel into
// their module graph.
import { addMdPanel } from "../reactdock";
import { baseName } from "../core";

// A #frag requested with the next open, consumed by the panel once its doc is
// ready (value "" = no frag). One-shot so reactivating an already-open panel
// doesn't re-scroll on the next unrelated render.
const pendingFrag = new Map<string, string>();

export function openMarkdownPanel(path: string, frag?: string): void {
  if (frag) pendingFrag.set(path, frag);
  addMdPanel(path, baseName(path));
}

export function takePendingFrag(path: string): string {
  const f = pendingFrag.get(path) ?? "";
  pendingFrag.delete(path);
  return f;
}
