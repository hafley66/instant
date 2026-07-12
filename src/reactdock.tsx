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
  const [editing, setEditing] = useState(false);
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
      { label: "Rename…", action: () => setEditing(true) },
      ...(customTitle(api.id) != null
        ? [{ label: "Reset name", action: () => renameTab(api.id, "") }]
        : []),
      ...(isTerm(api.id)
        ? [
            {
              label: hooks.isTermPinned(termSid(api.id)) ? "Unpin tab" : "Pin tab",
              action: () => hooks.toggleTermPin(termSid(api.id)),
            },
          ]
        : []),
      { sep: true },
      { label: "Split right", action: () => split("right") },
      { label: "Split down", action: () => split("below") },
      { label: "Split left", action: () => split("left") },
      { label: "Split up", action: () => split("above") },
      { sep: true },
      { label: "Close", action: () => api.close() },
    ];
    showContextMenu(e.clientX, e.clientY, items);
  };

  // Inline editor: commit on Enter/blur, cancel on Escape. stopPropagation on
  // pointer events so dockview's tab drag/activate doesn't hijack the input.
  if (editing) {
    return (
      <div className="dv-default-tab">
        <input
          className="dv-tab-rename"
          autoFocus
          defaultValue={seedTitle(api.id)}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            renameTab(api.id, e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              renameTab(api.id, e.currentTarget.value);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="dv-default-tab" onContextMenu={onContextMenu}>
      <span
        className="dv-default-tab-content"
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        {title}
      </span>
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

// Bump this whenever the Dockview JSON shape or panel lifecycle changes. In
// particular, an old layout can contain groups whose resources are disposed by
// a newer Dockview restore; keeping that JSON around makes every later
// addPanel() fail with the misleading "resource already disposed" error.
const LAYOUT_VERSION = 9; // 9: invalidate layouts from the disposed-group era

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
  // Re-derive a terminal's tab title (override + pin prefix live in main.ts).
  onTermRetitle: (sid: string) => void;
  // Pin state + toggle live in main.ts (keyed by session name); the tab context
  // menu reads/writes through these.
  isTermPinned: (sid: string) => boolean;
  toggleTermPin: (sid: string) => void;
};
let hooks: Hooks = {
  onTermActivate: () => {},
  onTermClose: () => {},
  onTermLayout: () => {},
  onTermRetitle: () => {},
  isTermPinned: () => false,
  toggleTermPin: () => {},
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
    title: withOverride("sessions", getPanel("sessions")?.title ?? "Sessions"),
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
      } catch (err) {
        // fromJSON can partially mutate Dockview before throwing. Do not keep
        // trying to use that half-restored group tree: clear it first, then
        // create one known-good panel and persist the clean layout.
        console.error("dock restore; rebuilding default layout", err);
        try {
          applyLayout(buildDefault);
        } catch (fallbackErr) {
          console.error("dock default layout", fallbackErr);
          // The API is still assigned so later diagnostics can identify the
          // failure, but callers must not mistake this for a usable dock.
          throw fallbackErr;
        }
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
  const base = { id: pid, component: "terminal", params: { panelId: pid }, title };
  // A restored-but-corrupt layout can leave the anchor's group disposed, so
  // addPanel throws "resource already disposed" and the new tab never opens
  // (cmd+T appears dead). Retry unanchored; if the whole gridview is wedged,
  // rebuild the default layout and try once more. Never let cmd+T throw.
  const tryAdd = (opts: Parameters<NonNullable<typeof api>["addPanel"]>[0]) => {
    try {
      api!.addPanel(opts);
      return true;
    } catch (e) {
      console.error("addTermPanel", e);
      return false;
    }
  };
  if (position && tryAdd({ ...base, position })) return;
  if (tryAdd(base)) return;
  applyLayout(buildDefault);
  tryAdd(base);
}

export function focusTermPanel(sid: string) {
  api?.getPanel(TERM + sid)?.api.setActive();
}
export function removeTermPanel(sid: string) {
  const p = api?.getPanel(TERM + sid);
  if (p) api!.removePanel(p);
}
// Ground truth for "does this terminal actually have a dockview panel right
// now" — main.ts's `tabs` Map is a parallel bookkeeping structure that can
// desync from dockview's own registry (e.g. a close whose onDidRemovePanel
// hasn't been processed yet). Callers that are about to trust `tabs.has(id)`
// to skip recreating a panel should cross-check this first.
export function hasTermPanel(sid: string): boolean {
  return !!api?.getPanel(TERM + sid);
}
export function setTermTitle(sid: string, title: string) {
  api?.getPanel(TERM + sid)?.api.setTitle(title);
}

// Durable per-panel title override (store.tabTitles, keyed by full panel id).
// Terminals/previews are recreated fresh on reload, so their renames can't ride
// the dock JSON — they're replayed from here. Tool panels persist in dock JSON
// too, but go through the same map so one path handles every tab.
export function customTitle(pid: string): string | undefined {
  return (store.get().tabTitles as Record<string, string>)[pid];
}
// Override for a terminal by its session id (main.ts keys by sid, not panel id).
export function customTermTitle(sid: string): string | undefined {
  return customTitle(TERM + sid);
}
// Apply `base` unless an override exists for this id. Used wherever a panel is
// (re)created so a renamed tab comes back named.
function withOverride(pid: string, base: string): string {
  return customTitle(pid) ?? base;
}
// Commit (or clear, when blank) a rename, then re-apply the visible title.
// Terminals route through onTermRetitle so main.ts can re-add the pin prefix.
export function renameTab(pid: string, title: string) {
  const t = title.trim();
  const cur = { ...(store.get().tabTitles as Record<string, string>) };
  if (t) cur[pid] = t;
  else delete cur[pid];
  store.set({ tabTitles: cur });
  if (isTerm(pid)) hooks.onTermRetitle(termSid(pid));
  else api?.getPanel(pid)?.api.setTitle(t || getPanel(pid)?.title || pid);
}
// What to seed the inline editor with: the override if present, else the
// natural base (session name for terminals, current title otherwise) so a
// pinned terminal's 📌 prefix isn't baked into the editable text.
function seedTitle(pid: string): string {
  const ov = customTitle(pid);
  if (ov != null) return ov;
  if (isTerm(pid)) return termSid(pid);
  return api?.getPanel(pid)?.api.title ?? "";
}
// Reorder a terminal tab within its group (used to float pinned tabs left).
export function moveTermPanel(sid: string, index: number) {
  const p = api?.getPanel(TERM + sid);
  if (!p) return;
  // Clamp to the panel's own group size — the caller's pinned counter is global,
  // but moveTo targets one group, so an out-of-range index throws gridview's
  // "invalid location" (which surfaced as new-tab opens failing). Never throw.
  const idx = Math.max(0, Math.min(index, p.group.panels.length - 1));
  try {
    p.api.moveTo({ group: p.group, index: idx });
  } catch (e) {
    console.error("moveTermPanel", e);
  }
}
// All panels in the active group, visual left-to-right order, as full panel ids.
// Tab nav (cmd+1..9 / next / prev) walks THIS so it reaches non-terminal panels
// sharing the bar (tmux v2, worktrees v2), not just terminals.
export function groupPanelIds(): string[] {
  const g = api?.activeGroup;
  return g ? g.panels.map((p) => p.id) : [];
}
// Every panel id across ALL groups, visual order (group order, then tab order).
// Drives cross-pane tab nav: next/prev (and cmd+1..9) walk every tab in every
// pane, and focusing one in another group activates that group too (setActive).
export function allPanelIds(): string[] {
  if (!api) return [];
  const out: string[] = [];
  for (const group of api.groups) {
    for (const p of group.panels) out.push(p.id);
  }
  return out;
}
export function activePanelId(): string | null {
  return api?.activePanel?.id ?? null;
}
// The DOM element of the active group (one tab pane). Dockview groups are
// absolutely positioned, so this is a valid positioning context for an overlay
// scoped to "the active tab's own space" (e.g. the in-pane toast).
export function activeGroupEl(): HTMLElement | null {
  return (api?.activeGroup?.element as HTMLElement | undefined) ?? null;
}
export function focusPanelById(pid: string) {
  api?.getPanel(pid)?.api.setActive();
}
// Close whatever panel is actually focused (dockview's active panel), not a
// store-tracked guess — cmd+W must close the tab you're looking at. For terminal
// panels this fires onDidRemovePanel -> onTermClosed (full teardown + closed-tab
// capture); tool panels (tmux v2, …) just close.
export function closeActivePanel() {
  const p = api?.activePanel;
  if (p) api!.removePanel(p);
}

// Terminal tab ids (the sid, i.e. the "s:name") in visual left-to-right order,
// flattened across groups. Drives cmd+1..9 / next/prev so they follow what the
// user sees (incl. pinned tabs floated left), not panel insertion order. Empty
// until the dock is ready -> caller falls back to its own open-order map.
export function termPanelOrder(): string[] {
  if (!api) return [];
  const out: string[] = [];
  for (const group of api.groups) {
    for (const p of group.panels) {
      if (isTerm(p.id)) out.push(p.id.slice(TERM.length));
    }
  }
  return out;
}

// Open (or focus) a per-path preview tab. The caller owns `el` and renders into
// it; we adopt it into a `preview:<path>` dock panel, mirroring addTermPanel.
export function addPreviewPanel(
  path: string,
  title: string,
  el: HTMLElement,
  direction: "within" | "right" = "within",
) {
  if (!api) return;
  const pid = PREVIEW + path;
  dynamicNodes.set(pid, el);
  const existing = api.getPanel(pid);
  if (existing) {
    existing.api.setActive();
    return;
  }
  // Stack new previews into the existing preview group if one is open (so they
  // share one tab strip); otherwise place the first preview relative to the
  // anchor (the terminals) in `direction` — "right" gives the split-right group.
  const openPreview = api.panels.find((p) => isPreview(p.id));
  let position:
    | { referencePanel: string; direction: "within" | "right" }
    | undefined;
  if (openPreview) {
    position = { referencePanel: openPreview.id, direction: "within" };
  } else {
    const anchor = anchorPanel();
    if (anchor) position = { referencePanel: anchor, direction };
  }
  api.addPanel({
    id: pid,
    component: "preview-instance",
    params: { panelId: pid },
    title: withOverride(pid, title),
    ...(position ? { position } : {}),
  });
}

export function isPreviewOpen(path: string): boolean {
  return !!api?.getPanel(PREVIEW + path);
}
// Focus an already-open preview panel by its key (the path/key passed to
// addPreviewPanel). Used for "back" routing from a file preview to the rg results
// panel it was opened from. No-op if that panel was since closed.
export function activatePreviewPanel(key: string): boolean {
  const p = api?.getPanel(PREVIEW + key);
  if (!p) return false;
  p.api.setActive();
  return true;
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
    title: withOverride(id, def?.title ?? id),
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
