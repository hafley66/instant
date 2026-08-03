import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { setDockStrip } from "../src/plugins/harnessTrace/DockStripPanel";
import { registerHarnessTracePlugin } from "../src/plugins/harnessTrace";
import { initRail } from "../src/rail";
import { activePanelId, addTermPanel, mountReactDock } from "../src/reactdock";
import { store } from "../src/state";
import { setHomeDir } from "../src/core";
import { wireContextMenu } from "../src/ctxmenu";

setHomeDir("/Users/e2e");
function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}
registerPlugin({
  id: "dock-strip-in-tab-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerHarnessTracePlugin();

// Spy on the strip's click = go there path (the panel calls this bridge).
const w = window as Window & { __dockStripOpened?: string };
setDockStrip({ onOpen: (name) => { w.__dockStripOpened = name; } });

// Two tmux sessions: s1 rooted at the claude parent + subagent cwd, s2 rooted
// at the other tree's cwd. The panel's terminal sid is "s1", so the in-tab
// strip must keep tree 1 (joined to s1) and drop tree 2 (joined to s2).
store.set({
  sessions: [
    { name: "s1", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/demo"], commands: ["claude"] },
    { name: "s2", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/other"], commands: ["claude"] },
  ],
  sessionWorktrees: { "s1": ["/Users/e2e/projects/demo"], "s2": ["/Users/e2e/projects/other"] },
});

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);

// Wait for the dock to initialize, then add a terminal panel for session "s1"
// with a stub element standing in for the xterm node, so TerminalPanel mounts
// with the in-tab relation strip beneath it.
const attempt = () => {
  if (activePanelId() == null) {
    setTimeout(attempt, 20);
    return;
  }
  const stub = document.createElement("div");
  stub.setAttribute("data-testid", "term-stub");
  stub.textContent = "s1 xterm";
  addTermPanel("s1", "s1", stub);
};
setTimeout(attempt, 20);
