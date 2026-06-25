// Dock layout via dockview-react. Panels are React components registered
// through the plugin registry (plugin.tsx). Terminal panels use a dedicated
// "terminal" component that adopts an xterm host element.
//
// Layout persists with a version stamp. Terminal panels are recreated fresh
// on reload from openTabs.

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
import { dockComponents, getPanel } from "./plugin";
import { showContextMenu, type CtxItem } from "./ctxmenu";

type SplitDir = "left" | "right" | "above" | "below";

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

const LAYOUT_VERSION = 8; // 8: per-path preview tabs; singleton preview panel removed

const TERM = "term:";
const isTerm = (id: string) => id.startsWith(TERM);
const termSid = (id: string) => id.slice(TERM.length);
const PREVIEW = "preview:";
const isPreview = (id: string) => id.startsWith(PREVIEW);
// Both terminals and previews adopt a content node owned by JS (not in the dock
// JSON), keyed by full panel id.
const dynamicNodes = new Map<string, HTMLElement>();

let api: DockviewApi | null = null;
let saving = false;

type Hooks = {
  onTermActivate: (sid: string) => void;
  onTermClose: (sid: string) => void;
  onTermLayout: (sid: string) => void;
};
let hooks: Hooks = {
  onTermActivate: () => {},
  onTermClose: () => {},
  onTermLayout: () => {},
};
export function setDockHooks(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h };
}

function TerminalPanel(props: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const sid = termSid(props.params.panelId as string);
  const id = props.params.panelId as string;

  useEffect(() => {
    const node = dynamicNodes.get(id);
    if (node && ref.current) ref.current.appendChild(node);

    const sub = props.api.onDidDimensionsChange(() => hooks.onTermLayout(sid));
    hooks.onTermLayout(sid);

    return () => {
      sub.dispose();
      const pool = document.getElementById("panel-pool");
      if (pool && node) pool.appendChild(node);
    };
  }, [id]);

  return <div className="dv-host" ref={ref} />;
}

// Per-path preview instance. Like terminals, the content node lives in JS
// (dynamicNodes) and is adopted on mount, returned to the pool on unmount.
// main.ts owns the node and renders into it; this just hosts it in the dock.
function PreviewPanel(props: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = props.params.panelId as string;

  useEffect(() => {
    const node = dynamicNodes.get(id);
    if (node && ref.current) ref.current.appendChild(node);
    return () => {
      const pool = document.getElementById("panel-pool");
      if (pool && node) pool.appendChild(node);
    };
  }, [id]);

  return <div className="dv-host dv-host-scroll" ref={ref} />;
}

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
  api.addPanel({
    id: "sessions",
    component: "sessions",
    params: { panelId: "sessions" },
    title: getPanel("sessions")?.title ?? "Sessions",
  });
}

// Terminals and previews don't survive a reload (their content nodes live in
// JS, not the dock JSON), so drop any husks restored from the saved layout.
function stripDynamicHusks() {
  if (!api) return;
  for (const p of [...api.panels]) if (isTerm(p.id) || isPreview(p.id)) api.removePanel(p);
}

function onReady(e: DockviewReadyEvent) {
  try {
    api = e.api;
    const saved = store.get().dockJSON as { v?: number; layout?: unknown } | null;
    if (saved && saved.v === LAYOUT_VERSION && saved.layout) {
      try {
        applyLayout(() => {
          api!.fromJSON(saved.layout as never);
          stripDynamicHusks();
        });
      } catch {
        applyLayout(buildDefault);
      }
    } else {
      applyLayout(buildDefault);
    }

    api.onDidActivePanelChange((p) => {
      if (p) lastActivePanelId = p.id;
      if (p && isTerm(p.id)) hooks.onTermActivate(termSid(p.id));
    });
    api.onDidRemovePanel((p) => {
      if (lastActivePanelId === p.id) lastActivePanelId = null;
      if (isTerm(p.id)) {
        dynamicNodes.delete(p.id);
        hooks.onTermClose(termSid(p.id));
      } else if (isPreview(p.id)) {
        dynamicNodes.delete(p.id);
      }
    });
    api.onDidLayoutChange(() => {
      if (!saving) persist();
      for (const fn of changeSubs) fn();
    });
    for (const fn of changeSubs) fn();
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    const el = document.getElementById("dock");
    if (el)
      el.innerHTML =
        `<pre style="color:#fff;background:#a00;padding:8px;margin:0;white-space:pre-wrap;font:11px monospace">[dock onReady] ${msg}</pre>`;
    console.error("[dock onReady]", err);
  }
}

const firstTermPanel = () => api?.panels.find((p) => isTerm(p.id))?.id;

let lastActivePanelId: string | null = null;
const anchorPanel = (): string | undefined => {
  if (lastActivePanelId && api?.getPanel(lastActivePanelId)) return lastActivePanelId;
  return firstTermPanel() ?? api?.panels[0]?.id;
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
  const anchor = anchorPanel();
  let position:
    | { referencePanel: string; direction: "within" | "right" }
    | undefined;
  if (anchor) position = { referencePanel: anchor, direction: "within" };
  api.addPanel({
    id: pid,
    component: "terminal",
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
// Reorder a terminal tab within its group (used to float pinned tabs left).
export function moveTermPanel(sid: string, index: number) {
  const p = api?.getPanel(TERM + sid);
  if (p) p.api.moveTo({ group: p.group, index });
}

// Open (or focus) a per-path preview tab. The caller owns `el` and renders into
// it; we adopt it into a `preview:<path>` dock panel, mirroring addTermPanel.
export function addPreviewPanel(path: string, title: string, el: HTMLElement) {
  if (!api) return;
  const pid = PREVIEW + path;
  dynamicNodes.set(pid, el);
  const existing = api.getPanel(pid);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const anchor = anchorPanel();
  const position = anchor
    ? { referencePanel: anchor, direction: "within" as const }
    : undefined;
  api.addPanel({
    id: pid,
    component: "preview-instance",
    params: { panelId: pid },
    title,
    ...(position ? { position } : {}),
  });
}

export function isPreviewOpen(path: string): boolean {
  return !!api?.getPanel(PREVIEW + path);
}
export function closePreviewPanel(path: string) {
  const p = api?.getPanel(PREVIEW + path);
  if (p) api!.removePanel(p);
}

export function togglePanel(id: string) {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  const ref = anchorPanel();
  const position = ref
    ? { referencePanel: ref, direction: "within" as const }
    : undefined;
  const def = getPanel(id);
  api.addPanel({
    id,
    component: id,
    params: { panelId: id },
    title: def?.title ?? id,
    ...(position ? { position } : {}),
  });
}

export function isOpen(id: string): boolean {
  return !!api?.getPanel(id);
}

const changeSubs: (() => void)[] = [];
export function onDockChange(fn: () => void) {
  changeSubs.push(fn);
}

function DockApp() {
  const comps = dockComponents();
  return createElement(DockviewReact, {
    components: { ...comps, terminal: TerminalPanel, "preview-instance": PreviewPanel },
    defaultTabComponent: CustomTab,
    theme: themeLight,
    onReady,
    className: "dv-fill",
    disableFloatingGroups: true,
  });
}

export function mountReactDock(el: HTMLElement) {
  createRoot(el).render(createElement(DockApp));
  setTimeout(() => {
    if (!api)
      el.insertAdjacentHTML(
        "afterbegin",
        `<pre style="color:#fff;background:#a06000;padding:8px;margin:0;font:11px monospace">[dock] onReady never fired — DockviewReact didn't initialize</pre>`,
      );
  }, 1500);
}