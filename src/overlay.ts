// Webview zoom (chrome: rail + toolbars + non-terminal panels) and the overlay
// controller: coexist with another app (VSCode) using built-in window APIs only —
// a "follow" mode that shows/hides as overlayTarget gains/loses focus, a faded
// (dimmed) look, a keyboard click-through toggle, and a compact "mini" layout.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { store } from "./state";
import { flashStatus } from "./core";

// ---- webview zoom (chrome: rail + toolbars + non-terminal panels) ----
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;
export function applyZoom() {
  getCurrentWebview().setZoom(store.get().zoom).catch(console.error);
}
export function nudgeZoom(delta: number) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(store.get().zoom + delta).toFixed(2)));
  store.set({ zoom: z });
  applyZoom();
}
export function resetZoom() {
  store.set({ zoom: 1 });
  applyZoom();
}

// ---- overlay controller ----
// No non-activating NSPanel (needs a native crate), so show() does activate us —
// but follow keys off frontmostApp, so the instant focus moves to a third app we
// hide again.
const OVERLAY_NORMAL = new LogicalSize(820, 540); // matches tauri.conf default
const OVERLAY_MINI = new LogicalSize(440, 360);
let overlayMiniApplied: boolean | null = null;
let overlayClickThrough = false;

export function applyOverlay() {
  const s = store.get();
  const app = document.getElementById("app");
  app?.classList.toggle("overlay-faded", s.overlayFade);
  app?.classList.toggle("mini", s.miniMode);
  const win = getCurrentWindow();
  // Resize only on an actual mini flip, not every store change.
  if (overlayMiniApplied !== s.miniMode) {
    overlayMiniApplied = s.miniMode;
    win.setSize(s.miniMode ? OVERLAY_MINI : OVERLAY_NORMAL).catch(() => {});
  }
  // Ride along over the target's desktop across Spaces while an overlay is active.
  win.setVisibleOnAllWorkspaces(s.overlayMode !== "off").catch(() => {});
  // Follow: mirror the target's focus (self-focus is filtered from frontmostApp).
  if (s.overlayMode === "follow" && s.frontmostApp) {
    if (s.frontmostApp === s.overlayTarget) win.show().catch(() => {});
    else win.hide().catch(() => {});
  }
}

export function toggleMiniMode() {
  store.set({ miniMode: !store.get().miniMode });
  flashStatus(store.get().miniMode ? "mini mode" : "full mode");
}
export function toggleOverlayFade() {
  store.set({ overlayFade: !store.get().overlayFade });
}
export function cycleOverlayMode() {
  const next = store.get().overlayMode === "off" ? ("follow" as const) : ("off" as const);
  store.set({ overlayMode: next });
  flashStatus(next === "follow" ? `overlay: follow ${store.get().overlayTarget}` : "overlay: off");
}
// Click-through: the window stops receiving mouse events (they pass to the app
// behind). Keyboard-only — while on you can't click the window to turn it back
// off, so it toggles by key by design.
export async function toggleClickThrough() {
  overlayClickThrough = !overlayClickThrough;
  await getCurrentWindow().setIgnoreCursorEvents(overlayClickThrough).catch(() => {});
  flashStatus(overlayClickThrough ? "click-through on" : "click-through off");
}
