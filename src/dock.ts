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
// discarded instead of restored. (v3: discard the blank-render v2 saves.)
const LAYOUT_VERSION = 3;

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
  // Capture the node reference now. dockview detaches the host (and this node)
  // from the document BEFORE calling dispose, so a getElementById there returns
  // null; the captured reference stays valid while detached.
  const node = panelNode(id);
  return {
    element,
    init() {
      element.appendChild(node);
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
      document.getElementById("panel-pool")?.appendChild(node);
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

  // The terminal is mandatory: a restored layout (or a bad fromJSON) might not
  // contain it, which would make every position:{referencePanel:"terminal"}
  // throw. Guarantee it exists before anything references it.
  ensureTerminal();

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
  if (api.getPanel("terminal")) {
    api.addPanel({
      id: "sessions",
      component: "host",
      title: titleOf("sessions"),
      position: { referencePanel: "terminal", direction: "left" },
    });
  }
}

function ensureTerminal() {
  if (api.getPanel("terminal")) return;
  saving = true;
  api.addPanel({ id: "terminal", component: "host", title: titleOf("terminal") });
  saving = false;
  persist();
}

// A panel id safe to dock against: prefer the terminal, else any open panel,
// else nothing (caller omits position -> dockview picks a default slot).
function anchorId(): string | undefined {
  if (api.getPanel("terminal")) return "terminal";
  return api.panels[0]?.id;
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

  // Build a position that never references a missing panel (omit it entirely if
  // there's no anchor; dockview then drops the panel in a default slot).
  let position:
    | { referencePanel: string; direction: "left" | "right" | "below" | "within" }
    | undefined;
  if (id === "sessions") {
    const ref = anchorId();
    if (ref) position = { referencePanel: ref, direction: "left" };
  } else {
    const sibling = TOOLS.find((t) => t !== id && api.getPanel(t));
    if (sibling) position = { referencePanel: sibling, direction: "within" };
    else {
      const ref = anchorId();
      if (ref) position = { referencePanel: ref, direction: DEFAULT_DIR[id] };
    }
  }
  api.addPanel({ id, component: "host", title: titleOf(id), ...(position ? { position } : {}) });
}

export function isOpen(id: PanelId): boolean {
  return !!api?.getPanel(id);
}

// main.ts subscribes the toolbar toggle highlights to this.
export function onDockChange(fn: () => void) {
  api.onDidLayoutChange(fn);
}
