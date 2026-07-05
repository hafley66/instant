// Activity rail: user-orderable (drag) and hideable (right-click), VS Code
// activity-bar style. Persisted via pluginState under id "rail". The pure
// merge/reorder/filter functions live in ./railOrder.ts (covered by
// railOrder.test.ts without any DOM); this file is the DOM/store wiring.
import { buildActivityRail, getPanel, panelIds, type PanelDef, type RailChild } from "./plugin";
import { readPluginState, savePluginState } from "./pluginState";
import { store } from "./state";
import { togglePanel } from "./reactdock";
import { syncToggles } from "./chrome";
import { showContextMenu, type CtxItem } from "./ctxmenu";
import {
  DEFAULT_RAIL_STATE,
  mergeOrder,
  moveBefore,
  resolveRailIds,
  toggleExpanded,
  toggleHidden,
  type RailState,
} from "./railOrder";

const RAIL_ID = "rail";

export function readRailState(): RailState {
  // savePluginState patches are partial: the slice on disk may hold only the
  // key that was ever written ({hidden} after a first hide, no order), so the
  // whole-slice fallback never fires. Normalize per key.
  const s = readPluginState<Partial<RailState>>(RAIL_ID, DEFAULT_RAIL_STATE);
  return { order: s.order ?? [], hidden: s.hidden ?? [], expanded: s.expanded ?? [] };
}

export function saveRailState(patch: Partial<RailState>): void {
  savePluginState<RailState>(RAIL_ID, patch);
}

const DRAG_THRESHOLD = 4; // px of pointer travel before a press becomes a drag

let lastKey = "";
const railKey = (s: RailState) => JSON.stringify(s);

// Stale-async guard for refreshChildren: each rebuild bumps the sequence, and
// an in-flight children fetch that resolves after a newer rebuild must not
// decorate the (freshly replaced) buttons with outdated chevrons/rows.
let rebuildSeq = 0;

function rebuild(): void {
  const state = readRailState();
  lastKey = railKey(state);
  const ids = resolveRailIds(panelIds(), state);
  const panels = ids.map(getPanel).filter((p): p is PanelDef => !!p);
  buildActivityRail(panels);
  // buildActivityRail() rebuilds #actbar-panels from scratch (see plugin.tsx),
  // so every button needs its click handler + active-state reapplied.
  for (const id of ids) {
    const btn = document.getElementById(`${id}-toggle`);
    if (btn) btn.onclick = () => togglePanel(id);
  }
  syncToggles();
  rebuildSeq++;
  void refreshChildren(rebuildSeq);
}

// Async pass over the freshly-built rail: any visible panel whose railChildren
// provider returns rows gets a ▸/▾ chevron inside its button; expanded panels
// also get their child rows rendered. Panels without a provider (or with an
// empty/failing one) keep a plain button — no dead affordance.
async function refreshChildren(seq: number): Promise<void> {
  const state = readRailState();
  const ids = resolveRailIds(panelIds(), state);
  for (const id of ids) {
    const p = getPanel(id);
    if (!p?.railChildren) continue;
    const kids = await p.railChildren().catch(() => [] as RailChild[]);
    if (seq !== rebuildSeq) return; // a newer rebuild replaced the buttons
    if (kids.length === 0) continue;
    const btn = document.getElementById(`${id}-toggle`);
    if (!btn) continue;
    const expanded = state.expanded.includes(id);
    const exp = document.createElement("span");
    exp.className = "actbar-exp";
    exp.textContent = expanded ? "▾" : "▸";
    // stopPropagation: the chevron lives inside the panel button, and a click
    // must toggle expansion without also toggling the panel itself.
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      saveRailState({ expanded: toggleExpanded(readRailState().expanded, id) });
      rebuild();
    });
    btn.appendChild(exp);
    if (expanded) renderChildren(id, kids);
  }
}

// Child rows sit after the panel's rail-tip element; like #actbar-panels the
// wrapper is display:contents, so each row is a direct flex child of .actbar.
// No data-panel attribute: wireDragReorder, panelButtonAt, and railMenuItems
// all key on `[data-panel]`, so child buttons stay invisible to reorder/hide.
function renderChildren(id: string, kids: RailChild[]): void {
  const tip = document.getElementById(`rail-tip-${id}`);
  if (!tip) return;
  const host = document.createElement("span");
  host.className = "actbar-children";
  for (const kid of kids) {
    const b = document.createElement("button");
    b.className = "actbar-child";
    b.textContent = kid.label;
    if (kid.hint) b.title = kid.hint;
    b.onclick = kid.run;
    host.appendChild(b);
  }
  tip.after(host);
}

// pluginState is one shared bag (src/pluginState.ts); any plugin saving its
// own slice replaces the whole object, so this fires for non-rail writes too
// (e.g. meme's UI state). Skip the rebuild when the rail's own slice didn't
// actually change.
function onPluginStateChange(): void {
  const key = railKey(readRailState());
  if (key === lastKey) return;
  rebuild();
}

function panelButtonAt(x: number, y: number): HTMLElement | null {
  return (
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
      ".actbar-item[data-panel]",
    ) ?? null
  );
}

// Pointerdown-based drag reorder (not HTML5 DnD): a plain click must still
// reach the button's onclick (togglePanel), so nothing is captured/prevented
// until the pointer has moved past DRAG_THRESHOLD.
function wireDragReorder(actbar: HTMLElement): void {
  actbar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".actbar-item[data-panel]");
    if (!btn) return;
    const panelId = btn.dataset.panel!;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let dragging = false;
    let order = mergeOrder(readRailState().order, panelIds());

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        btn.setPointerCapture(pointerId);
        btn.classList.add("actbar-dragging");
      }
      const overBtn = panelButtonAt(ev.clientX, ev.clientY);
      const overId = overBtn?.dataset.panel;
      if (!overBtn || !overId || overId === panelId) return;
      order = moveBefore(order, panelId, overId);
      // Live visual reorder: move the real button node so the drag reads as
      // continuous, not a snap-back-then-rebuild.
      const container = document.getElementById("actbar-panels");
      if (container) container.insertBefore(btn, overBtn);
    };
    const onUp = () => {
      actbar.removeEventListener("pointermove", onMove);
      actbar.removeEventListener("pointerup", onUp);
      actbar.removeEventListener("pointercancel", onUp);
      if (!dragging) return;
      try {
        btn.releasePointerCapture(pointerId);
      } catch {
        /* capture already gone */
      }
      btn.classList.remove("actbar-dragging");
      saveRailState({ order });
      rebuild();
    };
    actbar.addEventListener("pointermove", onMove);
    actbar.addEventListener("pointerup", onUp);
    actbar.addEventListener("pointercancel", onUp);
  });
}

function railMenuItems(): CtxItem[] {
  const state = readRailState();
  const ids = mergeOrder(state.order, panelIds());
  const hiddenSet = new Set(state.hidden);
  return ids.map((id) => {
    const p = getPanel(id);
    const shown = !hiddenSet.has(id);
    return {
      label: `${shown ? "✓" : " "} ${p?.title ?? id}`,
      action: () => {
        saveRailState({ hidden: toggleHidden(readRailState().hidden, id) });
        rebuild();
      },
    };
  });
}

// Right-click anywhere on the rail (not just a button) lists every registered
// panel with a checkmark for its visibility. Reuses ctxmenu.ts's
// showContextMenu directly rather than the global wireContextMenu(ctxItemsFor)
// dispatcher in main.ts — stopPropagation keeps that document-level listener
// from also firing for the same right-click.
function wireVisibilityMenu(actbar: HTMLElement): void {
  actbar.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, railMenuItems());
  });
}

export function initRail(): void {
  rebuild();
  const actbar = document.getElementById("actbar");
  if (!actbar) return;
  wireDragReorder(actbar);
  wireVisibilityMenu(actbar);
  store.subscribe(onPluginStateChange, ["pluginState"]);
}
