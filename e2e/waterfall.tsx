import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { setDockStrip } from "../src/plugins/harnessTrace/DockStripPanel";
import { registerHarnessTracePlugin } from "../src/plugins/harnessTrace";
import { initRail } from "../src/rail";
import { activePanelId, addTermPanel, mountReactDock, setDockHooks } from "../src/reactdock";
import { store } from "../src/state";
import { setHomeDir } from "../src/core";
import { wireContextMenu } from "../src/ctxmenu";
import { installKeymap } from "../src/keymap";
import { toggleTermStripFor } from "../src/plugins/harnessTrace/InTabStrip";

setHomeDir("/Users/e2e");
const TERM_SID = new URLSearchParams(location.search).get("term") ?? "s1";
function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}
registerPlugin({
  id: "waterfall-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerHarnessTracePlugin();

const w = window as Window & { __dockStripOpened?: string; __termRefits?: number };
setDockStrip({ onOpen: (name) => { w.__dockStripOpened = name; } });
setDockHooks({ onTermLayout: () => { w.__termRefits = (w.__termRefits ?? 0) + 1; } });

store.set({
  sessions: [
    { name: "s1", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/demo"], commands: ["claude"] },
  ],
  sessionWorktrees: { "s1": ["/Users/e2e/projects/demo"] },
});

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
installKeymap([
  { id: "term.strip", keys: ["$mod+Shift+Period"], run: () => toggleTermStripFor(TERM_SID) },
]);

const attempt = () => {
  if (activePanelId() == null) {
    setTimeout(attempt, 20);
    return;
  }
  const stub = document.createElement("div");
  stub.setAttribute("data-testid", "term-stub");
  stub.textContent = `${TERM_SID} xterm`;
  addTermPanel(TERM_SID, TERM_SID, stub);
};
setTimeout(attempt, 20);
