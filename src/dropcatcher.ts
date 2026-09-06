// Headless drop-catcher window. This is the ONLY surface in the app with the
// native Tauri drag handler (dragDropEnabled:true). The main window keeps it
// OFF so dockview can drag/split tabs via HTML5 DnD — on macOS WKWebView the two
// are mutually exclusive. The main window raises this window over its own bounds
// the moment a Finder drag enters (a normal DOM dragenter still fires there even
// with the handler off, it just can't read paths). Being always-on-top and
// covering the main window, this catcher becomes the OS drop target, reads the
// absolute paths the native handler provides, and emits them back to main.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { STASH_DROP_COMMAND, dropPath, unstashed, type StashedDrop } from "./0_dropStash";

const win = getCurrentWindow();
let idleTimer: number | undefined;

const clearIdle = () => {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
};

const cancelDrop = async () => {
  clearIdle();
  await emit("os-file-drop-cancel", {});
  await win.hide();
};

const keepAlive = () => {
  clearIdle();
  // Native `over` events continue while a Finder drag is alive. When release
  // races ahead of this window's native drop event, the event stream stops and
  // this removes the otherwise stranded full-window catcher.
  idleTimer = window.setTimeout(() => void cancelDrop(), 1000);
};

// macOS deletes the promise file behind a screenshot-thumbnail / Photos / Mail
// drag as soon as the drop completes, so the copy happens here, ahead of the emit.
const stash = (paths: string[]): Promise<StashedDrop[]> =>
  invoke<StashedDrop[]>(STASH_DROP_COMMAND, { paths }).catch(() => paths.map(unstashed));

getCurrentWebview().onDragDropEvent(async (e) => {
  const p = e.payload;
  if (p.type === "drop") {
    clearIdle();
    const drops = await stash(p.paths);
    await emit("os-file-drop", { paths: drops.map(dropPath), position: p.position, drops });
    await win.hide();
  } else if (p.type === "leave") {
    // Drag left the app without dropping; re-arm the main window and step aside.
    await cancelDrop();
  } else {
    keepAlive();
  }
});
