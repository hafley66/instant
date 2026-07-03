// Native OS file-drop without losing dockview tab-drag. The main window has the
// Tauri drag handler OFF (so HTML5 tab-drag works), which means a Finder drag
// fires a DOM dragenter here but exposes no file paths. On that dragenter we
// raise the `dropcatcher` window — the one surface WITH the native handler — over
// our exact bounds, let it read the absolute paths, and route them.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { handleMemeDrop } from "./meme";
import { activeId, pathArg, showError } from "./core";
import { tabs, pasteToActive } from "./terminal";
import { cancelHide } from "./capture";
import { addScope } from "./sprefa";

// True from the moment a Finder drag enters until the catcher reports a drop or
// cancel. Suppresses blur-to-hide (showing the catcher blurs us) and debounces
// repeat dragenter events.
let draggingIn = false;
export const isDraggingIn = () => draggingIn;
let dropWatchdog: number | undefined;

export async function wireOsDrop() {
  const main = getCurrentWindow();
  const catcher = await WebviewWindow.getByLabel("dropcatcher");
  if (!catcher) return;

  const standDown = () => {
    draggingIn = false;
    if (dropWatchdog !== undefined) {
      clearTimeout(dropWatchdog);
      dropWatchdog = undefined;
    }
  };

  window.addEventListener("dragenter", async (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    if (draggingIn) return;
    draggingIn = true;
    cancelHide(); // the catcher taking the drag must not auto-hide us
    const pos = await main.outerPosition();
    const size = await main.outerSize();
    await catcher.setPosition(new PhysicalPosition(pos.x, pos.y));
    await catcher.setSize(new PhysicalSize(size.width, size.height));
    await catcher.show();
    // Safety net: a drag cancelled outside the app may send no drop/leave.
    dropWatchdog = window.setTimeout(() => {
      standDown();
      catcher.hide().catch(() => {});
    }, 8000);
  });

  // Catcher covers us exactly, so its drop position (physical px, window-origin)
  // maps 1:1 onto ours. Over the sprefa scope tray → add file scope; otherwise
  // paste the paths into the active terminal.
  await listen<{ paths: string[]; position: { x: number; y: number } }>(
    "os-file-drop",
    (e) => {
      standDown();
      cancelHide();
      const { paths, position } = e.payload;
      if (!paths.length) return;
      const dpr = window.devicePixelRatio || 1;
      const over = document.elementFromPoint(position.x / dpr, position.y / dpr);
      if (over?.closest("#sprefa-scope")) {
        for (const path of paths) addScope({ kind: "file", value: path });
        return;
      }
      if (over?.closest("#meme-workspace")) {
        handleMemeDrop(paths).catch((e) => showError("meme-drop", e));
        return;
      }
      const id = activeId();
      if (!id) return;
      pasteToActive(paths.map(pathArg).join(" ") + " ");
      tabs.get(id)?.term.focus();
    },
  );

  await listen("os-file-drop-cancel", standDown);
}
