// Dock layout via dockview-react. React owns each panel's mount/unmount through
// useEffect, so there's no imperative init/dispose timing to get wrong (the
// class of bug that plagued the vanilla dockview-core version).
//
// Panel CONTENT is the existing DOM subtree parked in #panel-pool: a HostPanel
// adopts #panel-<id> on mount and returns it to the pool on unmount, so every
// render function in main.ts keeps targeting the same live nodes (and the live
// xterm) wherever the panel is docked. main.ts injects lazy-load + terminal-fit
// hooks via setDockHooks; layout persists with a version stamp.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import { store } from "./state";
import type { PanelId } from "./state";
import { DEFAULT_DIR } from "./state";
import { showContextMenu, type CtxItem } from "./ctxmenu";

type SplitDir = "left" | "right" | "above" | "below";

// Custom tab: same look as dockview's default (title + close ✕) plus a
// right-click menu that splits the panel in a direction. File-drop owns the
// native drag handler, so tabs can't be dragged; this menu is how panes move.
function CustomTab(props: IDockviewPanelHeaderProps) {
  const { api, containerApi } = props;
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    setTitle(api.title ?? "");
    const sub = api.onDidTitleChange((e) => setTitle(e.title));
    return () => sub.dispose();
  }, [api]);

  const split = (direction: SplitDir) => {
    const group = containerApi.addGroup({ referenceGroup: api.group, direction });
    api.moveTo({ group });
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: CtxItem[] = [
      { label: "Split right", action: () => split("right") },
      { label: "Split down", action: () => split("below") },
      { label: "Split left", action: () => split("left") },
      { label: "Split up", action: () => split("above") },
      { sep: true },
      { label: "Close", action: () => api.close() },
    ];
    showContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="dv-default-tab" onContextMenu={onContextMenu}>
      <span className="dv-default-tab-content">{title}</span>
      <span
        className="dv-default-tab-action"
        title="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          api.close();
        }}
      >
        ✕
      </span>
    </div>
  );
}

const LAYOUT_VERSION = 6; // bump to discard older saved layouts (6: drop floating groups)
const TOOLS: PanelId[] = ["files", "activity", "config", "worktrees"];

// Each tmux terminal is its own dockview panel, id `term:<sessionId>`. Its
// content is a live xterm host element registered here by main.ts (it isn't a
// pooled #panel-* node, it's created on the fly). HostPanel adopts from this
// map first, the pool second.
const TERM = "term:";
const isTerm = (id: string) => id.startsWith(TERM);
const termSid = (id: string) => id.slice(TERM.length);
const dynamicNodes = new Map<string, HTMLElement>();

let api: DockviewApi | null = null;
let saving = false;

type Hooks = {
  onShow: (id: PanelId) => void; // a tool/sessions panel mounted -> lazy load
  onTermActivate: (sid: string) => void; // a terminal panel became active
  onTermClose: (sid: string) => void; // a terminal panel was removed
  onTermLayout: (sid: string) => void; // a terminal panel resized -> refit
};
let hooks: Hooks = {
  onShow: () => {},
  onTermActivate: () => {},
  onTermClose: () => {},
  onTermLayout: () => {},
};
export function setDockHooks(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h };
}

// ---- panel content host: adopt the live node (dynamic terminal, or pooled) ----
function HostPanel(props: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = props.params.panelId as string;

  useEffect(() => {
    // Capture the node now. On unmount React removes this host div (and the
    // adopted node inside it) from the document BEFORE cleanup runs, so a
    // getElementById in cleanup returns null and the node would be destroyed
    // instead of pooled. The captured reference stays valid while detached.
    const node = dynamicNodes.get(id) ?? document.getElementById(`panel-${id}`);
    if (node && ref.current) ref.current.appendChild(node);

    let sub: { dispose(): void } | undefined;
    if (isTerm(id)) {
      // Refit this terminal whenever its group resizes.
      sub = props.api.onDidDimensionsChange(() => hooks.onTermLayout(termSid(id)));
      hooks.onTermLayout(termSid(id)); // fit on (re)mount too
    } else {
      hooks.onShow(id as PanelId); // lazy-load; the node is in the document now
    }

    return () => {
      sub?.dispose();
      const pool = document.getElementById("panel-pool");
      if (pool && node) pool.appendChild(node); // park the captured node for re-open
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
  api.addPanel({ id: "sessions", component: "host", params: { panelId: "sessions" }, title: "Sessions" });
}

// Terminal panels can't be restored from JSON: their xterm content is recreated
// fresh on reload (openTabs replay). Drop any term husks the saved layout left
// behind so a later addTermPanel with the same id doesn't collide.
function stripTermHusks() {
  if (!api) return;
  for (const p of [...api.panels]) if (isTerm(p.id)) api.removePanel(p);
}

function onReady(e: DockviewReadyEvent) {
  try {
    api = e.api;
    const saved = store.get().dockJSON as { v?: number; layout?: unknown } | null;
    if (saved && saved.v === LAYOUT_VERSION && saved.layout) {
      try {
        applyLayout(() => {
          api!.fromJSON(saved.layout as never);
          stripTermHusks();
        });
      } catch {
        applyLayout(buildDefault);
      }
    } else {
      applyLayout(buildDefault);
    }

    api.onDidActivePanelChange((p) => {
      if (p && isTerm(p.id)) {
        lastActiveTermId = p.id; // new terminals open into this group
        hooks.onTermActivate(termSid(p.id));
      }
    });
    api.onDidRemovePanel((p) => {
      if (isTerm(p.id)) {
        if (lastActiveTermId === p.id) lastActiveTermId = null;
        dynamicNodes.delete(p.id);
        hooks.onTermClose(termSid(p.id));
      }
    });
    api.onDidLayoutChange(() => {
      if (!saving) persist();
      for (const fn of changeSubs) fn();
    });
    for (const fn of changeSubs) fn(); // initial highlight sync
  } catch (err) {
    // onReady runs inside React's render commit; a throw here is swallowed and
    // leaves an empty dock. Surface it where it can be seen.
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    const el = document.getElementById("dock");
    if (el)
      el.innerHTML =
        `<pre style="color:#fff;background:#a00;padding:8px;margin:0;white-space:pre-wrap;font:11px monospace">[dock onReady] ${msg}</pre>`;
    console.error("[dock onReady]", err);
  }
}

// ---- terminal panels (one dockview panel per tmux session) ----
// main.ts owns the xterm; it hands us the host element + title and we place it
// as a flat, draggable/splittable dockview tab next to its siblings.
const firstTermPanel = () => api?.panels.find((p) => isTerm(p.id))?.id;

// Last terminal panel that held focus. New terminals open as a tab in this
// panel's group, so they land where you were working instead of spawning a new
// column. Cleared when that panel closes; falls back to the first terminal.
let lastActiveTermId: string | null = null;
const anchorTermPanel = (): string | undefined => {
  if (lastActiveTermId && api?.getPanel(lastActiveTermId)) return lastActiveTermId;
  return firstTermPanel();
};

export function addTermPanel(sid: string, title: string, el: HTMLElement) {
  if (!api) return;
  const pid = TERM + sid;
  dynamicNodes.set(pid, el);
  const existing = api.getPanel(pid);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const anchor = anchorTermPanel();
  let position:
    | { referencePanel: string; direction: "within" | "right" }
    | undefined;
  if (anchor) position = { referencePanel: anchor, direction: "within" };
  else if (api.getPanel("sessions"))
    position = { referencePanel: "sessions", direction: "right" };
  api.addPanel({
    id: pid,
    component: "host",
    params: { panelId: pid },
    title,
    ...(position ? { position } : {}),
  });
}

export function focusTermPanel(sid: string) {
  api?.getPanel(TERM + sid)?.api.setActive();
}
export function removeTermPanel(sid: string) {
  const p = api?.getPanel(TERM + sid);
  if (p) api!.removePanel(p);
}
export function setTermTitle(sid: string, title: string) {
  api?.getPanel(TERM + sid)?.api.setTitle(title);
}

// ---- public api for main.ts (rail toggles, highlights) ----
const TITLES: Record<PanelId, string> = {
  sessions: "Sessions",
  worktrees: "Worktrees",
  activity: "Activity",
  files: "Files",
  preview: "Preview",
  config: "Config",
};

// Open the Preview pane next to Files (its own dockview group, so it's
// draggable/splittable independently). No-op if already open.
export function ensurePreview() {
  if (!api || api.getPanel("preview")) return;
  const ref = api.getPanel("files") ? "files" : api.panels[0]?.id;
  api.addPanel({
    id: "preview",
    component: "host",
    params: { panelId: "preview" },
    title: "Preview",
    ...(ref ? { position: { referencePanel: ref, direction: "right" as const } } : {}),
  });
}

// Close the Preview pane (nothing selected -> don't reserve space for it).
export function closePreview() {
  const p = api?.getPanel("preview");
  if (p) api!.removePanel(p);
}

export function togglePanel(id: PanelId) {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  const anchor = () => firstTermPanel() ?? api!.panels[0]?.id;
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
    defaultTabComponent: CustomTab,
    theme: themeLight,
    onReady,
    className: "dv-fill",
    // Dragging a tab out spawned a detached floating panel that read as broken.
    // Keep docking/split/reorder drags; just disable the float-out mode.
    disableFloatingGroups: true,
  });
}

export function mountReactDock(el: HTMLElement) {
  createRoot(el).render(createElement(DockApp));
  // Diagnostic: if onReady never fires, the dock stays empty silently.
  setTimeout(() => {
    if (!api)
      el.insertAdjacentHTML(
        "afterbegin",
        `<pre style="color:#fff;background:#a06000;padding:8px;margin:0;font:11px monospace">[dock] onReady never fired — DockviewReact didn't initialize</pre>`,
      );
  }, 1500);
}
