// Webview zoom (chrome: rail + toolbars + non-terminal panels) and the overlay
// controller: coexist with another app (VSCode) using built-in window APIs only —
// a "follow" mode that shows/hides as overlayTarget gains/loses focus, a faded
// (dimmed) look, a keyboard click-through toggle, and a compact "mini" layout.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { store } from "./state";
import { flashStatus } from "./core";
import { overlaySizeTransition } from "./0_overlaySize";
import { overlay } from "./0_overlaySettings";
import { merge } from "rxjs";
import { settings } from "./0_settings";

// ---- webview zoom (chrome: rail + toolbars + non-terminal panels) ----
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;
export function applyZoom() {
  getCurrentWebview().setZoom(settings.zoom.$()).catch(console.error);
}
export function nudgeZoom(delta: number) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(settings.zoom.$() + delta).toFixed(2)));
  settings.zoom.$(z);
  applyZoom();
}
export function resetZoom() {
  settings.zoom.$(1);
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
  const mini = overlay.mini.$();
  const mode = overlay.mode.$();
  const app = document.getElementById("app");
  app?.classList.toggle("overlay-faded", overlay.fade.$());
  app?.classList.toggle("mini", mini);
  const win = getCurrentWindow();
  // A normal-mode boot keeps the native restored size. Persisted mini mode and
  // later user toggles still apply their authored sizes.
  const sizeTransition = overlaySizeTransition(overlayMiniApplied, mini);
  overlayMiniApplied = mini;
  if (sizeTransition)
    win.setSize(sizeTransition === "mini" ? OVERLAY_MINI : OVERLAY_NORMAL).catch(() => {});
  // Ride along over the target's desktop across Spaces while an overlay is active.
  win.setVisibleOnAllWorkspaces(mode !== "off").catch(() => {});
  // Follow: mirror the target's focus (self-focus is filtered from frontmostApp).
  const frontmost = store.get().frontmostApp;
  if (mode === "follow" && frontmost) {
    if (frontmost === overlay.target.$()) win.show().catch(() => {});
    else win.hide().catch(() => {});
  }
}

/** Re-applies on any settings change and on the frontmost app, which is runtime
 *  state and stays in the store. Each signal replays on subscribe, so this also
 *  covers the boot pass that restored a persisted mini/fade/follow. */
export function bindOverlay() {
  merge(overlay.mode.$, overlay.target.$, overlay.fade.$, overlay.mini.$).subscribe(
    () => applyOverlay(),
  );
  store.subscribe(applyOverlay, ["frontmostApp"]);
}

export function toggleMiniMode() {
  const next = !overlay.mini.$();
  overlay.mini.$(next);
  flashStatus(next ? "mini mode" : "full mode");
}
export function toggleOverlayFade() {
  overlay.fade.$(!overlay.fade.$());
}
export function cycleOverlayMode() {
  const next = overlay.mode.$() === "off" ? ("follow" as const) : ("off" as const);
  overlay.mode.$(next);
  flashStatus(next === "follow" ? `overlay: follow ${overlay.target.$()}` : "overlay: off");
}
// Click-through: the window stops receiving mouse events (they pass to the app
// behind). Keyboard-only — while on you can't click the window to turn it back
// off, so it toggles by key by design.
export async function toggleClickThrough() {
  overlayClickThrough = !overlayClickThrough;
  await getCurrentWindow().setIgnoreCursorEvents(overlayClickThrough).catch(() => {});
  flashStatus(overlayClickThrough ? "click-through on" : "click-through off");
}
