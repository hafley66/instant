// Dock layout: four resizable zones (left / center / right / bottom), each
// holding a tab list of panels. Panels are real DOM subtrees parked in
// #panel-pool; mounting MOVES a panel into a zone body (appendChild), which
// preserves its ids, listeners, and live xterm — so every render function in
// main.ts keeps targeting the same elements wherever the panel is docked.
//
// State lives in store.dock (persisted). Mutators clone it and store.set, whose
// subscription re-runs mountDock. Drag a tab to another zone to re-dock; drag a
// zone divider to resize. The terminal is pinned to center (no close/undock).

import { store } from "./state";
import type { PanelId, Zone, DockLayout } from "./state";
import { DEFAULT_ZONE } from "./state";

const ZONES: Zone[] = ["left", "center", "right", "bottom"];
const PANELS: PanelId[] = [
  "terminal",
  "sessions",
  "worktrees",
  "activity",
  "files",
  "config",
];

const byId = (id: string) => document.getElementById(id)!;
const panelEl = (id: PanelId) => byId(`panel-${id}`);
const zoneEl = (z: Zone) => byId(`zone-${z}`);
const zbody = (z: Zone) => zoneEl(z).querySelector<HTMLElement>(".zbody")!;
const ztabs = (z: Zone) => zoneEl(z).querySelector<HTMLElement>(".ztabs")!;
const pool = () => byId("panel-pool");

// main.ts injects a lazy-load hook fired when a panel becomes the active tab.
let onShow: (id: PanelId) => void = () => {};
export function setDockHooks(h: { onShow: (id: PanelId) => void }) {
  onShow = h.onShow;
}

const clone = (d: DockLayout): DockLayout => ({
  slots: { left: [...d.slots.left], center: [...d.slots.center], right: [...d.slots.right], bottom: [...d.slots.bottom] },
  active: { ...d.active },
  sizes: { ...d.sizes },
});
const zoneOf = (d: DockLayout, id: PanelId): Zone | null =>
  ZONES.find((z) => d.slots[z].includes(id)) ?? null;
const commit = (d: DockLayout) => store.set({ dock: d });

// ---- mount: reconcile the DOM to store.dock ----
export function mountDock() {
  const d = store.get().dock;

  // Move each panel to its target zone body (or the pool if undocked). Only
  // touch the DOM when the parent actually changes, so the terminal isn't
  // needlessly re-parented (which would churn its xterm size).
  for (const id of PANELS) {
    const z = zoneOf(d, id);
    const dest = z ? zbody(z) : pool();
    if (panelEl(id).parentElement !== dest) dest.appendChild(panelEl(id));
  }

  for (const z of ZONES) renderZone(z, d);
  applySizes(d);
}

function renderZone(z: Zone, d: DockLayout) {
  const zone = zoneEl(z);
  const ids = d.slots[z];
  zone.classList.toggle("empty", ids.length === 0);
  if (ids.length === 0) {
    ztabs(z).innerHTML = "";
    return;
  }
  const active = Math.max(0, Math.min(d.active[z] ?? 0, ids.length - 1));

  // Enforce slot order + active visibility within the body.
  ids.forEach((id, i) => {
    const el = panelEl(id);
    zbody(z).appendChild(el); // re-append in order
    el.classList.toggle("hidden", i !== active);
  });

  // Tab strip. A single-panel zone still shows its tab (it's the drag handle).
  const tabs = ztabs(z);
  tabs.innerHTML = "";
  ids.forEach((id, i) => tabs.appendChild(makeTab(z, id, i === active)));

  // Fire the lazy-load hook only when the active panel actually changes, not on
  // every mount (a resize drag would otherwise re-trigger scans every frame).
  if (lastShown[z] !== ids[active]) {
    lastShown[z] = ids[active];
    onShow(ids[active]);
  }
}
const lastShown: Partial<Record<Zone, PanelId>> = {};

function makeTab(z: Zone, id: PanelId, active: boolean): HTMLElement {
  const tab = document.createElement("div");
  tab.className = "ztab" + (active ? " active" : "");
  tab.draggable = id !== "terminal"; // terminal is pinned to center
  tab.dataset.panel = id;
  tab.textContent = panelEl(id).dataset.label ?? id;
  tab.onclick = () => setActive(z, id);

  if (id !== "terminal") {
    const x = document.createElement("span");
    x.className = "ztab-close";
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      togglePanel(id); // undock
    };
    tab.appendChild(x);
  }

  tab.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/panel", id);
    e.dataTransfer!.effectAllowed = "move";
  });
  return tab;
}

// ---- mutators ----
export function togglePanel(id: PanelId) {
  if (id === "terminal") return; // pinned
  const d = clone(store.get().dock);
  const z = zoneOf(d, id);
  if (z) {
    d.slots[z].splice(d.slots[z].indexOf(id), 1);
    d.active[z] = Math.max(0, d.active[z] - 1);
  } else {
    addTo(d, DEFAULT_ZONE[id], id);
  }
  commit(d);
}

function movePanel(id: PanelId, to: Zone) {
  if (id === "terminal") return; // pinned to center
  const d = clone(store.get().dock);
  const from = zoneOf(d, id);
  if (from === to) return;
  if (from) d.slots[from].splice(d.slots[from].indexOf(id), 1);
  addTo(d, to, id);
  commit(d);
}

function setActive(z: Zone, id: PanelId) {
  const d = clone(store.get().dock);
  d.active[z] = d.slots[z].indexOf(id);
  commit(d);
}

function addTo(d: DockLayout, z: Zone, id: PanelId) {
  d.slots[z].push(id);
  d.active[z] = d.slots[z].length - 1;
}

export function isOpen(id: PanelId): boolean {
  return zoneOf(store.get().dock, id) !== null;
}

// ---- sizes + collapse ----
function applySizes(d: DockLayout) {
  zoneEl("left").style.width = `${d.sizes.left}px`;
  zoneEl("right").style.width = `${d.sizes.right}px`;
  zoneEl("bottom").style.height = `${d.sizes.bottom}px`;

  // A divider is only useful when both sides it separates are present.
  const show = (edge: string, on: boolean) => {
    const el = document.querySelector<HTMLElement>(`.zdiv[data-edge="${edge}"]`);
    if (el) el.style.display = on ? "" : "none";
  };
  show("left", d.slots.left.length > 0);
  show("right", d.slots.right.length > 0);
  show("bottom", d.slots.bottom.length > 0);
}

// ---- wiring (once, at boot) ----
export function wireDock() {
  wireResizers();
  wireDropZones();
  mountDock();
}

function wireResizers() {
  for (const div of document.querySelectorAll<HTMLElement>(".zdiv")) {
    const edge = div.dataset.edge as "left" | "right" | "bottom";
    let dragging = false;
    let next = 0;
    // Live-apply size to the element during the drag (cheap, no store churn);
    // commit once on release so the heavy dock subscriber + lazy-loads run once.
    div.addEventListener("pointerdown", (e) => {
      dragging = true;
      div.setPointerCapture(e.pointerId);
      div.classList.add("dragging");
    });
    div.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dock = byId("dock").getBoundingClientRect();
      if (edge === "left") {
        next = clamp(e.clientX - dock.left, 120, 460);
        zoneEl("left").style.width = `${next}px`;
      } else if (edge === "right") {
        next = clamp(dock.right - e.clientX, 160, 560);
        zoneEl("right").style.width = `${next}px`;
      } else {
        next = clamp(dock.bottom - e.clientY, 80, dock.height - 120);
        zoneEl("bottom").style.height = `${next}px`;
      }
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      div.releasePointerCapture(e.pointerId);
      div.classList.remove("dragging");
      const d = clone(store.get().dock);
      d.sizes[edge] = next;
      commit(d);
    };
    div.addEventListener("pointerup", end);
    div.addEventListener("pointercancel", end);
  }
}

function wireDropZones() {
  for (const z of ZONES) {
    const zone = zoneEl(z);
    zone.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("text/panel")) {
        e.preventDefault();
        zone.classList.add("drop-hover");
      }
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-hover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-hover");
      const id = e.dataTransfer?.getData("text/panel") as PanelId;
      if (id) movePanel(id, z);
    });
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
