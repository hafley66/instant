// Headless drop-catcher window. This is the ONLY surface in the app with the
// native Tauri drag handler (dragDropEnabled:true). The main window keeps it
// OFF so dockview can drag/split tabs via HTML5 DnD — on macOS WKWebView the two
// are mutually exclusive. The main window raises this window over its own bounds
// the moment a Finder drag enters (a normal DOM dragenter still fires there even
// with the handler off, it just can't read paths). Being always-on-top and
// covering the main window, this catcher becomes the OS drop target, reads the
// absolute paths the native handler provides, and emits them back to main.
import { runtimePorts } from "./reactive/ports";
import { invoke } from "./generated/native";
import { STASH_DROP_COMMAND, dropPath, unstashed, type StashedDrop } from "./0_dropStash";

let idleTimer: number | undefined;

const clearIdle = () => {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
};

const cancelDrop = async () => {
  clearIdle();
  await runtimePorts.emit("os-file-drop-cancel", {});
  await runtimePorts.window.hide();
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

void runtimePorts.webview.onDragDrop(async (p) => {
  if (p.type === "drop") {
    clearIdle();
    const drops = await stash(p.paths);
    await runtimePorts.emit("os-file-drop", {
      paths: drops.map(dropPath),
      position: { x: p.position.x, y: p.position.y },
      drops,
    });
    await runtimePorts.window.hide();
  } else if (p.type === "leave") {
    // Drag left the app without dropping; re-arm the main window and step aside.
    await cancelDrop();
  } else {
    keepAlive();
  }
});
