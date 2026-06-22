// Dock layout, powered by dockview-core (vanilla, zero-dep). dockview owns all
// the drag / split / resize / tab / serialize logic; we only feed it our panel
// DOM and react to its events.
//
// Each dockable surface is a DOM subtree parked in #panel-pool. A dockview
// "host" component wraps one and appends it on init, so ids / listeners / the
// live xterm survive being moved between groups. defaultRenderer:"always" keeps
// hidden tabs mounted (xterm must not be destroyed when its tab is inactive).
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
    defaultRenderer: "always",
    createComponent: (o) => hostRenderer(o.id as PanelId),
  });

  const saved = store.get().dockJSON;
  if (saved) {
    try {
      applyLayout(() => api.fromJSON(saved as never));
    } catch {
      applyLayout(buildDefault);
    }
  } else {
    applyLayout(buildDefault);
  }

  api.onDidLayoutChange(() => {
    if (!saving) store.set({ dockJSON: api.toJSON() });
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

function applyLayout(fn: () => void) {
  saving = true;
  fn();
  saving = false;
  store.set({ dockJSON: api.toJSON() });
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

// Toolbar toggle: open the panel next to the terminal, or close it if open.
export function togglePanel(id: PanelId) {
  if (id === "terminal") return; // always present
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  api.addPanel({
    id,
    component: "host",
    title: titleOf(id),
    position: { referencePanel: "terminal", direction: DEFAULT_DIR[id] },
  });
}

export function isOpen(id: PanelId): boolean {
  return !!api?.getPanel(id);
}

// main.ts subscribes the toolbar toggle highlights to this.
export function onDockChange(fn: () => void) {
  api.onDidLayoutChange(fn);
}
