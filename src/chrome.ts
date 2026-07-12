// Window chrome + store-driven view sync: skin/mode/toolbar/sidebar → DOM, the
// activity-rail resize, the title bar drag/controls, the minimal async text
// prompt, JS-driven window edge resize (macOS gives no native handles), and the
// contextual right-click menu items.
import { invoke } from "./generated/native";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { store, type AppState, type SprefaScopeKind } from "./state";
import { allPanels } from "./plugin";
import { togglePanel, isOpen } from "./reactdock";
import { type CtxItem } from "./ctxmenu";
import { $, nextSkin, THEMES, termFontFamily, activeId, pathArg, relTime } from "./core";
import { tabs, tabMetaById, cellDims, pasteToActive } from "./terminal";
import { captureToPrompt, openSendPicker } from "./capture";
import {
  tabTurns,
  searchTurns,
  ledgerQuery,
  isTurnFav,
  favoriteTurn,
  unfavoriteTurn,
  turnCwd,
  warmTurns,
} from "./favorites";
import { inScope, toggleScope } from "./sprefa";
import { openTabAtPwd } from "./tabs";

// syncToggles now reads from the plugin registry instead of a hardcoded list.
export function syncToggles() {
  for (const p of allPanels()) {
    const btn = document.getElementById(`${p.id}-toggle`);
    if (btn) btn.classList.toggle("active", isOpen(p.id));
  }
}

// Activity rail compact (icons) vs big (icons + labels).
export function syncSidebar(s: AppState) {
  $("#actbar").dataset.mode = s.sidebar;
  applyRailWidth();
}

// Big mode honors the persisted drag width; compact falls back to the fixed
// 44px CSS rule (clear the inline width so it isn't pinned wide).
function applyRailWidth() {
  const bar = $("#actbar");
  if (store.get().sidebar === "big") bar.style.width = `${store.get().sidebarWidth}px`;
  else bar.style.removeProperty("width");
}

// Drag the divider on the rail's right edge to resize it (big mode only); the
// width persists in the store. Pointer capture so the drag survives fast moves.
export function wireRailResize() {
  const grip = $("#actbar-resize");
  grip.addEventListener("pointerdown", (e) => {
    if (store.get().sidebar !== "big") return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = store.get().sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(96, Math.min(360, startW + (ev.clientX - startX)));
      store.set({ sidebarWidth: w });
      applyRailWidth();
    };
    const onUp = (ev: PointerEvent) => {
      grip.releasePointerCapture(ev.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  });
}

// ---- store-driven view sync: skin and mode push to the DOM + controls ----
export function syncSkin(s: AppState) {
  document.body.dataset.skin = s.skin;
  // Button shows the skin it switches TO.
  ($("#skin-toggle") as HTMLButtonElement).textContent = nextSkin(s.skin).toUpperCase();
  for (const t of tabs.values()) {
    t.term.options.theme = THEMES[s.skin];
    t.fit.fit();
  }
}
// "Super XP": toggle the body class that forces the grainy pixel UI font on the
// chrome (CSS in styles.css), and re-font every live terminal. The font swap
// changes the cell box, so fit() reflows cols/rows and we push the new size +
// pixel dims to the pty (mirrors the focus path; onResize also fires resize_pty
// but cellDims can change without cols/rows, so we send it explicitly).
export async function syncXpPixel(s: AppState) {
  document.body.classList.toggle("xp-pixel", s.xpPixel);
  // xterm's canvas renderer measures the font synchronously; if the pixel
  // webfont isn't loaded yet it silently falls back to Menlo and the terminal
  // never changes. Load it first, then apply + reflow.
  if (s.xpPixel) {
    try {
      await document.fonts.load('16px "Perfect DOS VGA 437 Win"');
    } catch {
      // font API unavailable / load failed; apply anyway (falls back to Menlo)
    }
  }
  const family = termFontFamily();
  for (const t of tabs.values()) {
    t.term.options.fontFamily = family;
    t.term.refresh(0, t.term.rows - 1); // force a redraw with the new metrics
    t.fit.fit();
    invoke("resize_pty", {
      id: t.id, cols: t.term.cols, rows: t.term.rows, ...cellDims(t.term),
    }).catch(() => {});
  }
}
// Top toolbar (Shot / dark / skin) is opt-in: hidden unless showToolbar. Its
// functions stay reachable from the palette, so hiding it strands nothing.
export function applyToolbar(s: AppState) {
  document.body.classList.toggle("show-toolbar", s.showToolbar);
}
export function syncMode(s: AppState) {
  document.body.dataset.mode = s.mode;
  ($("#mode-toggle") as HTMLButtonElement).textContent =
    s.mode === "dark" ? "☀" : "☾";
}

// Minimal async text prompt. window.prompt() is a no-op in the Tauri WKWebview,
// so reuse the command-palette overlay styling for a real input. Resolves to the
// trimmed value, or null on Esc / backdrop click / empty.
export function askText(placeholder: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "cmdp-root";
    const box = document.createElement("div");
    box.className = "cmdp-box";
    const input = document.createElement("input");
    input.className = "cmdp-input";
    input.type = "text";
    input.placeholder = placeholder;
    input.value = initial;
    input.spellcheck = false;
    box.appendChild(input);
    root.appendChild(box);
    const close = (val: string | null) => {
      root.remove();
      resolve(val);
    };
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) close(null);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim() || null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
    document.body.appendChild(root);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

// Window edge/corner grips. decorations:false means macOS gives no native
// resize handles, and Tauri's startResizeDragging is a no-op on macOS (tao's
// drag_resize_window returns NotSupported for every direction), so we drive the
// resize ourselves: capture the pointer, track the screen-space delta, and push
// new size/position to the window. screenX/screenY are logical (CSS) px, which
// is what LogicalSize/LogicalPosition expect — no scale-factor juggling needed.
const MIN_W = 420;
const MIN_H = 320;
export function wireWindowResize() {
  const win = getCurrentWindow();
  document.querySelectorAll<HTMLElement>(".rz").forEach((grip) => {
    const dir = grip.dataset.dir ?? "";
    grip.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = await win.scaleFactor();
      const p = await win.outerPosition();
      const s = await win.outerSize();
      const ox = p.x / scale;
      const oy = p.y / scale;
      const ow = s.width / scale;
      const oh = s.height / scale;
      const startX = e.screenX;
      const startY = e.screenY;
      grip.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        // The primary button is no longer down — a pointerup was missed (the
        // setSize/setPosition reflow below can swallow it via lostpointercapture
        // with no pointerup). Tear down so moves stop resizing "from far away".
        if ((ev.buttons & 1) === 0) {
          stop(ev.pointerId);
          return;
        }
        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;
        let w = ow;
        let h = oh;
        if (dir.includes("East")) w = ow + dx;
        if (dir.includes("West")) w = ow - dx;
        if (dir.includes("South")) h = oh + dy;
        if (dir.includes("North")) h = oh - dy;
        w = Math.max(w, MIN_W);
        h = Math.max(h, MIN_H);
        // Native window managers can reject an intermediate size while the
        // pointer is still moving (especially North/NorthWest, which also
        // repositions the window). These are best-effort frame updates; an
        // unhandled rejection here used to surface as a resize error.
        void win.setSize(new LogicalSize(w, h)).catch((err) => {
          console.debug("window resize frame rejected", err);
          stop(ev.pointerId);
        });
        // West/North move the anchored (far) edge; keep it fixed by shifting the
        // origin so only the dragged edge tracks the cursor. Clamp-aware: derive
        // the shift from the clamped size, not the raw delta.
        if (dir.includes("West") || dir.includes("North")) {
          const nx = dir.includes("West") ? ox + (ow - w) : ox;
          const ny = dir.includes("North") ? oy + (oh - h) : oy;
          void win.setPosition(new LogicalPosition(nx, ny)).catch((err) => {
            console.debug("window reposition frame rejected", err);
            stop(ev.pointerId);
          });
        }
      };
      // Single idempotent teardown, reachable from every end condition.
      const stop = (pointerId: number) => {
        try {
          grip.releasePointerCapture(pointerId);
        } catch {
          // capture may already be gone
        }
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        grip.removeEventListener("lostpointercapture", onUp);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };
      const onUp = (ev: PointerEvent) => stop(ev.pointerId);
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
      // lostpointercapture fires when the reflow steals capture without a
      // pointerup; window-level up/cancel catch a release outside the grip.
      grip.addEventListener("lostpointercapture", onUp);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    });
  });
}

// Viewport Y of the last right-click, captured (capture phase) before
// wireContextMenu's bubble handler, so ctxItemsFor can map it to a terminal
// buffer row for turn-identify.
let lastCtxY = 0;
export const setLastCtxY = (y: number) => {
  lastCtxY = y;
};

// Contextual right-click items, keyed off what the click landed on. Row data is
// recovered from the row's title attr (file rows carry the path, activity rows
// the shot/url/text), so no per-row wiring is needed.
export function ctxItemsFor(target: HTMLElement): CtxItem[] {
  const copy = (s: string) => navigator.clipboard.writeText(s).catch(() => {});

  // Any draggable entity (file/repo/rev) — result cells and fs rows carry these.
  const ent = target.closest("[data-entity-kind]") as HTMLElement | null;
  const entKind = ent?.dataset.entityKind as SprefaScopeKind | undefined;
  const entVal = ent?.dataset.entityValue ?? "";
  const scopeItems = (): CtxItem[] =>
    ent && entKind
      ? [
          {
            label: inScope(entKind, entVal) ? "Remove from selection" : "Add to selection",
            action: () => toggleScope(entKind, entVal),
          },
        ]
      : [];

  // A sprefa result cell tagged as an entity.
  if (ent && entKind) {
    const items: CtxItem[] = [...scopeItems(), { label: "Copy", action: () => copy(entVal) }];
    if (entKind === "file")
      items.push({ label: "Open (paste path)", action: () => pasteToActive(pathArg(entVal) + " ") });
    items.push(
      { sep: true },
      {
        label: "Clear selection",
        action: () => store.set({ sprefaScope: [] }),
        disabled: store.get().sprefaScope.length === 0,
      },
    );
    return items;
  }

  // An activity-timeline row.
  const actRow = target.closest("#activity-table tr.dtable-row") as HTMLElement | null;
  if (actRow?.title) {
    const data = actRow.title;
    return [
      { label: "Paste", action: () => pasteToActive(data + " ") },
      { label: "Copy", action: () => copy(data) },
    ];
  }

  // Inside a terminal.
  if (target.closest(".term-host")) {
    const id = activeId();
    const meta = id ? tabMetaById(id) : null;
    const turns = id ? tabTurns.get(id) ?? [] : [];
    const matches = id && meta ? searchTurns(turns, ledgerQuery(id, lastCtxY)) : [];
    const turnItems: CtxItem[] = [];
    const noop = () => {};
    if (matches.length && meta) {
      turnItems.push({
        label: `${matches.length} turn match${matches.length > 1 ? "es" : ""} (★ to save)`,
        action: noop,
        disabled: true,
      });
      for (const m of matches) {
        const p = m.preview.slice(0, 44);
        const star = isTurnFav(m) ? "✓" : "★";
        turnItems.push({
          label: `${star} ${m.role} · ${relTime(m.ts)} · ${p}${m.preview.length > 44 ? "…" : ""}`,
          action: () =>
            void (isTurnFav(m)
              ? unfavoriteTurn(m)
              : favoriteTurn(m, turnCwd.get(`${m.editor}:${m.session_id}`) ?? meta.cwd)),
        });
      }
      turnItems.push({ sep: true });
    } else if (meta) {
      // No match — cache may be cold (warm for next time) or no ledger text hit.
      if (id) void warmTurns(id);
      turnItems.push({
        label: turns.length ? "no turn matches selection" : "no AI session for this tab",
        action: noop,
        disabled: true,
      });
      turnItems.push({ sep: true });
    }
    return [
      ...turnItems,
      {
        label: "Paste",
        action: async () => {
          try {
            pasteToActive(await navigator.clipboard.readText());
          } catch {
            /* clipboard blocked */
          }
        },
      },
      {
        label: "Clear",
        action: () => {
          const id = activeId();
          if (id) tabs.get(id)?.term.clear();
        },
      },
      { sep: true },
      { label: "Screenshot region", action: captureToPrompt },
    ];
  }

  // Default: window-level actions.
  return [
    {
      label: "New session",
      action: openTabAtPwd,
    },
    { sep: true },
    { label: "Cycle skin", action: () => store.set({ skin: nextSkin(store.get().skin) }) },
    {
      label: store.get().xpPixel ? "Super XP: off" : "Super XP: on",
      action: () => store.set({ xpPixel: !store.get().xpPixel }),
    },
    {
      label: store.get().mode === "dark" ? "Light mode" : "Dark mode",
      action: () =>
        store.set({ mode: store.get().mode === "dark" ? "light" : "dark" }),
    },
  ];
}

export function wireChrome() {
  $("#skin-toggle").onclick = () =>
    store.set({ skin: nextSkin(store.get().skin) });

  $("#mode-toggle").onclick = () =>
    store.set({ mode: store.get().mode === "dark" ? "light" : "dark" });

  $("#shot-btn").onclick = captureToPrompt;
  $("#send-menu-btn").onclick = (e) => openSendPicker(e.currentTarget as HTMLElement);

  for (const p of allPanels()) {
    const btn = document.getElementById(`${p.id}-toggle`);
    if (btn) btn.onclick = () => togglePanel(p.id);
  }
  $("#actbar-toggle").onclick = () =>
    store.set({ sidebar: store.get().sidebar === "big" ? "compact" : "big" });

  $("#min-btn").onclick = () => getCurrentWindow().minimize();
  $("#max-btn").onclick = () => getCurrentWindow().toggleMaximize();
  $("#hide-btn").onclick = () => getCurrentWindow().hide();

  // Own the drag region in JS instead of `data-tauri-drag-region`: that attribute
  // only matches the exact event target, so grabbing the caption text (a child)
  // started a text-selection instead of a window drag. Listening on the bar and
  // routing by target covers every child.
  //
  // Drag is single-press only; maximize is a dedicated dblclick. The old code
  // toggled maximize on the *second* mousedown (detail===2) but had already
  // begun a native startDragging on the first — that drag racing the maximize
  // resize left the window in a half-drag state and spat mouse-report garbage
  // into the focused tmux/xterm. Starting the drag only on detail===1 (and
  // maximizing from dblclick) removes the race.
  const titleBar = $(".title-bar");
  const onControls = (t: EventTarget | null) =>
    !!(t as HTMLElement | null)?.closest(".title-bar-controls");
  titleBar.addEventListener("mousedown", (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || onControls(me.target)) return;
    me.preventDefault(); // no caption text-selection / focus steal
    if (me.detail === 1) getCurrentWindow().startDragging();
  });
  titleBar.addEventListener("dblclick", (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || onControls(me.target)) return;
    me.preventDefault();
    getCurrentWindow().toggleMaximize();
  });
}
