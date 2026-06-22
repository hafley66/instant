// Dock layout, powered by dockview-core (vanilla, zero-dep). dockview owns all
// the drag / split / resize / tab / serialize logic; we only feed it our panel
// DOM and react to its events.
//
// Each dockable surface is a DOM subtree parked in #panel-pool. A dockview
// "host" component wraps one and appends it on init, so ids / listeners / the
// live xterm survive being moved between groups. On dispose (panel closed) the
// subtree is returned to the pool, so re-opening re-adopts the same live nodes.
//
// Persistence is dockview's own toJSON/fromJSON, stored as state.dockJSON.

import {
  createDockview,
  themeLight,
  type DockviewApi,
  type IContentRenderer,
} from "dockview-core";
import "dockview-core/dist/styles/dockview.css";

import { store } from "./state";
import type { PanelId } from "./state";
import { DEFAULT_DIR } from "./state";

// Bump when the default layout shape changes so stale/corrupt saved layouts are
// discarded instead of restored.
const LAYOUT_VERSION = 2;

// Tools share one side group (tab together) instead of each spawning a column.
const TOOLS: PanelId[] = ["files", "activity", "config", "worktrees"];

let api: DockviewApi;
let saving = false; // guard: don't persist while we're applying a load

type Hooks = { onShow: (id: PanelId) => void; onTerminalLayout: () => void };
let hooks: Hooks = { onShow: () => {}, onTerminalLayout: () => {} };
export function setDockHooks(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h };
}

const panelNode = (id: PanelId) => document.getElementById(`panel-${id}`)!;
const titleOf = (id: PanelId) => panelNode(id).dataset.label ?? id;

// One renderer per panel: its element is a thin host that adopts the pooled
// panel subtree. dockview calls layout() on every resize -> refit the terminal.
function hostRenderer(id: PanelId): IContentRenderer {
  const element = document.createElement("div");
  element.className = "dv-host";
  return {
    element,
    init() {
      element.appendChild(panelNode(id));
      hooks.onShow(id); // lazy-load on first mount (onShow isn't guaranteed)
    },
    onShow() {
      hooks.onShow(id);
    },
    layout() {
      if (id === "terminal") hooks.onTerminalLayout();
    },
    dispose() {
      // Return the subtree to the pool so it (and its xterm) survives removal.
      document.getElementById("panel-pool")?.appendChild(panelNode(id));
    },
  };
}

export function wireDock() {
  const el = document.getElementById("dock")!;
  api = createDockview(el, {
    theme: themeLight, // colors are overridden per-skin via #dock CSS vars
    createComponent: (o) => hostRenderer(o.id as PanelId),
  });

  const saved = store.get().dockJSON as { v?: number; layout?: unknown } | null;
  if (saved && saved.v === LAYOUT_VERSION && saved.layout) {
    try {
      applyLayout(() => api.fromJSON(saved.layout as never));
    } catch {
      applyLayout(buildDefault);
    }
  } else {
    applyLayout(buildDefault);
  }

  api.onDidLayoutChange(() => {
    if (!saving) persist();
  });

  // The terminal is required. dockview tabs render their own close (×); if the
  // user closes the terminal, re-add it. Its subtree + live xterm survived in
  // the pool (see dispose), so re-adopting them loses nothing. Skip during
  // applyLayout's clear(), which legitimately removes every panel.
  api.onDidRemovePanel((p) => {
    if (p.id === "terminal" && !saving && !api.getPanel("terminal")) {
      api.addPanel({ id: "terminal", component: "host", title: titleOf("terminal") });
    }
  });
}

function persist() {
  store.set({ dockJSON: { v: LAYOUT_VERSION, layout: api.toJSON() } });
}

function applyLayout(fn: () => void) {
  saving = true;
  fn();
  saving = false;
  persist();
}

// First-run layout: terminal in the center, sessions docked left.
function buildDefault() {
  api.clear();
  api.addPanel({ id: "terminal", component: "host", title: titleOf("terminal") });
  api.addPanel({
    id: "sessions",
    component: "host",
    title: titleOf("sessions"),
    position: { referencePanel: "terminal", direction: "left" },
  });
}

// Rail toggle: close the panel if open, else open it. Sessions docks left as its
// own group; tools (files/activity/config/worktrees) tab into a single shared
// side group so toggling doesn't spray a new column per panel.
export function togglePanel(id: PanelId) {
  if (id === "terminal") return; // always present
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  if (id === "sessions") {
    api.addPanel({
      id,
      component: "host",
      title: titleOf(id),
      position: { referencePanel: "terminal", direction: "left" },
    });
    return;
  }
  // Tool: tab into an already-open tool's group, else start a new right column.
  const sibling = TOOLS.find((t) => t !== id && api.getPanel(t));
  api.addPanel({
    id,
    component: "host",
    title: titleOf(id),
    position: sibling
      ? { referencePanel: sibling, direction: "within" }
      : { referencePanel: "terminal", direction: DEFAULT_DIR[id] },
  });
}

export function isOpen(id: PanelId): boolean {
  return !!api?.getPanel(id);
}

// main.ts subscribes the toolbar toggle highlights to this.
export function onDockChange(fn: () => void) {
  api.onDidLayoutChange(fn);
}
