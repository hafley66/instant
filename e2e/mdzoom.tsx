// E2E bootstrap for per-panel zoom (src/panelZoom.ts): a markdown viewer tab
// and a terminal tab in one dock, with the real keymap zoom commands bound.
// Import order mirrors src/main.ts so module evaluation order (and any import
// cycle it walks into) matches the app. Native (Tauri) edge is mocked via
// __instantE2eNativeResults (src/reactive/nativeTransport.ts).
import "xp.css";
import "@xterm/xterm/css/xterm.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "../src/generated/native";
import { store, type FsEntry } from "../src/state";
import { registerPlugin } from "../src/plugin";
import { initRail } from "../src/rail";
import { FileTree } from "../src/plugins/files/1_FileTree";
import { registerMdview } from "../src/mdview";
import { installMdviewHost } from "../src/mdview/ports";
import { installKeymap, type Command } from "../src/keymap";
import { claimFsWatch } from "../src/fsWatch";
import { registerZoomKind, resetPanelZoom } from "../src/panelZoom";
import { readPluginState, savePluginState } from "../src/pluginState";
import { useApp } from "../src/useStore";
import {
  mountReactDock,
  setDockHooks,
  addMdPanel,
  mdPanelId,
  activePanelId,
} from "../src/reactdock";
import { setHomeDir, sessionId } from "../src/core";
import {
  openTab,
  onTermShown,
  onTermClosed,
  fitTerm,
  tabMetaById,
  getFocusedTermId,
  zoomGesture,
  zoomResetGesture,
} from "../src/terminal";
import { wireContextMenu } from "../src/ctxmenu";

const ROOT = "/tmp/mdzoom-e2e";
const DOC = `${ROOT}/zoom.md`;
const DOC_TEXT = `# Zoom target

A paragraph with an [external link](https://example.com/research) under the heading.

\`\`\`http
POST /arrivals  { batch: [ add tree, add fruit, del leaf ] }
\`\`\`
`;
const openedHrefs: { href: string; sourcePath: string }[] = [];
const entry = (path: string, is_dir = false): FsEntry => ({
  name: path.split("/").pop()!,
  path,
  is_dir,
  size: is_dir ? 0 : 64,
  modified: 0,
  ext: is_dir ? "" : path.split(".").pop()!,
});

type E2eWindow = Window & { __instantE2eNativeResults?: Record<string, unknown> };
(window as E2eWindow).__instantE2eNativeResults = {
  read_text: DOC_TEXT,
  list_dir: (args: Record<string, unknown> | undefined) => {
    const path = String(args?.path ?? ROOT);
    if (path !== ROOT) return { path, parent: ROOT, entries: [] };
    return { path, parent: "/tmp", entries: [entry(DOC)] };
  },
};

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}
registerPlugin({
  id: "mdzoom-e2e-sessions",
  panels: [
    { id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel },
  ],
});

setHomeDir("/tmp");
setDockHooks({
  onTermActivate: onTermShown,
  onTermClose: onTermClosed,
  onTermLayout: fitTerm,
  onTermRetitle: () => {},
  isTermPinned: () => false,
  toggleTermPin: () => {},
  onTermCwd: (sid) => tabMetaById(sid)?.cwd ?? null,
});

installMdviewHost({
  readText: (path) => invoke<string>("read_text", { path }),
  readImage: (path) => invoke<string>("read_image", { path }),
  listDir: (path) => invoke<{ entries: FsEntry[] }>("list_dir", { path }),
  openHref: async (href, sourcePath) => { openedHrefs.push({ href, sourcePath }); },
  watchFile: (path, onChange, recursive) => claimFsWatch(path, onChange, recursive),
  FileTree,
  registerZoomKind,
  resetPanelZoom,
  readPluginState,
  savePluginState,
  useAppState: () => {
    const app = useApp();
    return { dark: app.mode === "dark", panelZoom: app.panelZoom };
  },
  openMdPanel: addMdPanel,
  mdPanelId,
  registerPlugin,
});
registerMdview();

// The three zoom bindings copied from src/main.ts's command table, plus a
// keyboard opener: the ⌘-click-a-path flow opens the preview without the mouse
// ever leaving the terminal, so the terminal keeps DOM focus.
const ZOOM_STEP = 0.1;
const commands: Command[] = [
  { id: "app.zoomIn", keys: ["$mod+Equal", "$mod+Shift+Equal"], run: () => zoomGesture(ZOOM_STEP) },
  { id: "app.zoomOut", keys: ["$mod+Minus"], run: () => zoomGesture(-ZOOM_STEP) },
  { id: "app.zoomReset", keys: ["$mod+Digit0"], run: zoomResetGesture },
  { id: "e2e.openMd", keys: ["$mod+Shift+m"], run: () => addMdPanel(DOC, "zoom.md") },
];
installKeymap(commands);

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);

type ZoomHooks = {
  doc: string;
  mdPid: string;
  termPid: string;
  factors: () => Record<string, number>;
  focusedTerm: () => string | null;
  activePanel: () => string | null;
  openedHrefs: () => typeof openedHrefs;
};
(window as Window & { __mdzoom?: ZoomHooks }).__mdzoom = {
  doc: DOC,
  mdPid: mdPanelId(DOC),
  termPid: `term:${sessionId("e2e")}`,
  factors: () => store.get().panelZoom,
  focusedTerm: getFocusedTermId,
  activePanel: activePanelId,
  openedHrefs: () => [...openedHrefs],
};

document.querySelector<HTMLButtonElement>("[data-testid=open-md]")!.onclick = () =>
  addMdPanel(DOC, "zoom.md");
document.querySelector<HTMLButtonElement>("[data-testid=open-term]")!.onclick = () =>
  openTab("e2e", { cwd: ROOT });
