// Signals-backed state for the mdview panel: the per-path doc cache, per-path
// collapse sets, and the persisted UI options. Follows the
// reactive/statusModel.ts idiom — Signal for state, SignalReact in the panel
// reads it; mutations go through the helpers so signal + pluginState stay in
// sync no matter where they're toggled from.
import { Signal, type Signal$ } from "@hafley66/signals";
import { invoke } from "../generated/native";
import { readPluginState, savePluginState } from "../pluginState";
import { allSectionIds, parseMdSections, type MdDoc } from "./model";

const PLUGIN_ID = "md";

export interface MdUi {
  startFolded: boolean; // open docs fully folded (TOC/outline first) — default ON
  layout: number[] | null; // global default [explorer, content] percentages
  layouts: Record<string, number[]>; // per-tab split overrides, keyed by panel id
  explorerHidden: boolean; // explorer sidebar collapsed (global)
}

const DEFAULT_UI: MdUi = { startFolded: true, layout: null, layouts: {}, explorerHidden: false };

export const mdUi = Signal<MdUi>({
  ...DEFAULT_UI,
  ...readPluginState<Partial<MdUi>>(PLUGIN_ID, {}),
});

export function setMdUi(patch: Partial<MdUi>): void {
  mdUi.$({ ...mdUi.$(), ...patch });
  savePluginState<MdUi>(PLUGIN_ID, patch);
}

const FALLBACK_LAYOUT = [26, 74];

// Persist a drag result for this tab AND as the global default new tabs open
// with ("remember globally/per panel/tab").
export function setLayoutFor(pid: string, layout: number[]): void {
  setMdUi({ layout, layouts: { ...mdUi.$().layouts, [pid]: layout } });
}

export function layoutFor(pid: string): number[] {
  const ui = mdUi.$();
  return ui.layouts[pid] ?? ui.layout ?? FALLBACK_LAYOUT;
}

export function toggleExplorer(): void {
  setMdUi({ explorerHidden: !mdUi.$().explorerHidden });
}

// Per-panel current document path. Keyed by panel id so navigation survives a
// dock remount (the React subtree remounts, the panel id doesn't change).
export type StrSignal = { $: Signal$<string> };
const panelPaths = new Map<string, StrSignal>();

export function pathSignalFor(pid: string, initial: string): StrSignal {
  let sig = panelPaths.get(pid);
  if (!sig) {
    sig = Signal(initial);
    panelPaths.set(pid, sig);
  }
  return sig;
}

export type MdDocState =
  | { status: "loading" }
  | { status: "ready"; text: string; doc: MdDoc }
  | { status: "error"; error: string };

export const mdDocs = Signal<Record<string, MdDocState>>({});

export async function loadMdDoc(path: string): Promise<void> {
  const cur = mdDocs.$()[path];
  if (cur && cur.status !== "error") return;
  mdDocs.$({ ...mdDocs.$(), [path]: { status: "loading" } });
  try {
    const text = await invoke<string>("read_text", { path });
    mdDocs.$({ ...mdDocs.$(), [path]: { status: "ready", text, doc: parseMdSections(text) } });
  } catch (e) {
    mdDocs.$({ ...mdDocs.$(), [path]: { status: "error", error: String(e) } });
  }
}

// Per-open-panel collapse state (session-only — a reopen re-applies the
// startFolded default). One Signal per path so a fold only re-renders its own
// panel. The lib's node type isn't exported (only the Signal$ accessor type
// is), so the map is typed structurally.
type SetSignal = { $: Signal$<Set<string>> };
const collapsedSignals = new Map<string, SetSignal>();
// Paths whose collapse set has already been initialized from a ready doc (vs a
// signal created while the doc was still loading, which got the empty set).
const readyInited = new Set<string>();

export function collapsedFor(path: string): SetSignal {
  let sig = collapsedSignals.get(path);
  if (!sig) {
    sig = Signal<Set<string>>(defaultCollapsed(path));
    collapsedSignals.set(path, sig);
  }
  return sig;
}

function defaultCollapsed(path: string): Set<string> {
  if (!mdUi.$().startFolded) return new Set();
  const state = mdDocs.$()[path];
  return state?.status === "ready" ? allSectionIds(state.doc) : new Set();
}

// Called by the panel when its doc flips to ready: a collapse set created
// during loading (empty) now gets the folded default applied once.
export function initCollapsedForReadyDoc(path: string): void {
  if (readyInited.has(path)) return;
  readyInited.add(path);
  collapsedFor(path).$(defaultCollapsed(path));
}

export function toggleCollapsed(path: string, id: string): void {
  const sig = collapsedFor(path);
  const next = new Set(sig.$());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  sig.$(next);
}

export function expandIds(path: string, ids: string[]): void {
  const sig = collapsedFor(path);
  const next = new Set(sig.$());
  for (const id of ids) next.delete(id);
  sig.$(next);
}

export function setAllCollapsed(path: string, collapsed: boolean): void {
  readyInited.add(path); // an explicit user gesture, not the auto-default
  collapsedFor(path).$(collapsed ? defaultCollapsedAll(path) : new Set());
}

function defaultCollapsedAll(path: string): Set<string> {
  const state = mdDocs.$()[path];
  return state?.status === "ready" ? allSectionIds(state.doc) : new Set();
}

export function closeMdDoc(path: string): void {
  collapsedSignals.delete(path);
  readyInited.delete(path);
  const next = { ...mdDocs.$() };
  delete next[path];
  mdDocs.$(next);
}
