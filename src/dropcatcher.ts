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

const win = getCurrentWindow();

getCurrentWebview().onDragDropEvent(async (e) => {
  const p = e.payload;
  if (p.type === "drop") {
    await emit("os-file-drop", { paths: p.paths, position: p.position });
    await win.hide();
  } else if (p.type === "leave") {
    // Drag left the app without dropping; re-arm the main window and step aside.
    await emit("os-file-drop-cancel", {});
    await win.hide();
  }
  // "enter"/"over": stay up; the dashed zone is the visible drop affordance.
});
