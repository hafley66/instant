// Dock layout via dockview-react. React owns each panel's mount/unmount through
// useEffect, so there's no imperative init/dispose timing to get wrong (the
// class of bug that plagued the vanilla dockview-core version).
//
// Panel CONTENT is the existing DOM subtree parked in #panel-pool: a HostPanel
// adopts #panel-<id> on mount and returns it to the pool on unmount, so every
// render function in main.ts keeps targeting the same live nodes (and the live
// xterm) wherever the panel is docked. main.ts injects lazy-load + terminal-fit
// hooks via setDockHooks; layout persists with a version stamp.

import { useEffect, useRef } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import { store } from "./state";
import type { PanelId } from "./state";
import { DEFAULT_DIR } from "./state";

const LAYOUT_VERSION = 4; // bump to discard older saved layouts
const TOOLS: PanelId[] = ["files", "activity", "config", "worktrees"];

let api: DockviewApi | null = null;
let saving = false;

type Hooks = { onShow: (id: PanelId) => void; onTerminalLayout: () => void };
let hooks: Hooks = { onShow: () => {}, onTerminalLayout: () => {} };
export function setDockHooks(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h };
}

// ---- panel content host: adopt the pooled DOM subtree ----
function HostPanel(props: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = props.params.panelId as PanelId;

  useEffect(() => {
    const node = document.getElementById(`panel-${id}`);
    if (node && ref.current) ref.current.appendChild(node);
    hooks.onShow(id); // lazy-load; the node is in the document now

    // Terminal must refit when its group resizes.
    const sub =
      id === "terminal"
        ? props.api.onDidDimensionsChange(() => hooks.onTerminalLayout())
        : undefined;

    return () => {
      sub?.dispose();
      const pool = document.getElementById("panel-pool");
      const n = document.getElementById(`panel-${id}`);
      if (pool && n) pool.appendChild(n); // park it; survives for re-open
    };
  }, [id]);

  return <div className="dv-host" ref={ref} />;
}

// ---- layout persistence (versioned) ----
function persist() {
  if (api) store.set({ dockJSON: { v: LAYOUT_VERSION, layout: api.toJSON() } });
}
function applyLayout(fn: () => void) {
  saving = true;
  fn();
  saving = false;
  persist();
}

function buildDefault() {
  if (!api) return;
  api.clear();
  api.addPanel({ id: "terminal", component: "host", params: { panelId: "terminal" }, title: "Terminal" });
  if (api.getPanel("terminal")) {
    api.addPanel({
      id: "sessions",
      component: "host",
      params: { panelId: "sessions" },
      title: "Sessions",
      position: { referencePanel: "terminal", direction: "left" },
    });
  }
}

function ensureTerminal() {
  if (!api || api.getPanel("terminal")) return;
  saving = true;
  api.addPanel({ id: "terminal", component: "host", params: { panelId: "terminal" }, title: "Terminal" });
  saving = false;
  persist();
}

function onReady(e: DockviewReadyEvent) {
  api = e.api;
  const saved = store.get().dockJSON as { v?: number; layout?: unknown } | null;
  if (saved && saved.v === LAYOUT_VERSION && saved.layout) {
    try {
      applyLayout(() => api!.fromJSON(saved.layout as never));
    } catch {
      applyLayout(buildDefault);
    }
  } else {
    applyLayout(buildDefault);
  }
  ensureTerminal();

  api.onDidLayoutChange(() => {
    if (!saving) persist();
    for (const fn of changeSubs) fn();
  });
  for (const fn of changeSubs) fn(); // initial highlight sync
}

// ---- public api for main.ts (rail toggles, highlights) ----
const TITLES: Record<PanelId, string> = {
  terminal: "Terminal",
  sessions: "Sessions",
  worktrees: "Worktrees",
  activity: "Activity",
  files: "Files",
  config: "Config",
};

export function togglePanel(id: PanelId) {
  if (!api || id === "terminal") return;
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  const anchor = () => (api!.getPanel("terminal") ? "terminal" : api!.panels[0]?.id);
  let position:
    | { referencePanel: string; direction: "left" | "right" | "below" | "within" }
    | undefined;
  if (id === "sessions") {
    const ref = anchor();
    if (ref) position = { referencePanel: ref, direction: "left" };
  } else {
    const sibling = TOOLS.find((t) => t !== id && api!.getPanel(t));
    if (sibling) position = { referencePanel: sibling, direction: "within" };
    else {
      const ref = anchor();
      if (ref) position = { referencePanel: ref, direction: DEFAULT_DIR[id] };
    }
  }
  api.addPanel({
    id,
    component: "host",
    params: { panelId: id },
    title: TITLES[id],
    ...(position ? { position } : {}),
  });
}

export function isOpen(id: PanelId): boolean {
  return !!api?.getPanel(id);
}

const changeSubs: (() => void)[] = [];
export function onDockChange(fn: () => void) {
  changeSubs.push(fn);
}

// ---- mount (called from main.ts, no JSX there) ----
function DockApp() {
  return createElement(DockviewReact, {
    components: { host: HostPanel },
    theme: themeLight,
    onReady,
    className: "dv-fill",
  });
}

export function mountReactDock(el: HTMLElement) {
  createRoot(el).render(createElement(DockApp));
}
