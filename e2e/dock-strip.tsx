import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { registerHarnessTracePlugin } from "../src/plugins/harnessTrace";
import { setDockStrip } from "../src/plugins/harnessTrace/DockStripPanel";
import { initRail } from "../src/rail";
import { mountReactDock } from "../src/reactdock";
import { store } from "../src/state";
import { setHomeDir } from "../src/core";
import { wireContextMenu } from "../src/ctxmenu";

setHomeDir("/Users/e2e");
function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}
registerPlugin({
  id: "dock-strip-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerHarnessTracePlugin();

// Spy on the strip's click = go there path (the panel calls this bridge).
const w = window as Window & { __dockStripOpened?: string };
setDockStrip({ onOpen: (name) => { w.__dockStripOpened = name; } });

// One tmux session rooted at the claude parent + subagent cwd. Its proc names
// the claude harness, so those rows join it. The dispatch (oc-dispatch) cwd has
// no matching tmux session and stays unjoined.
store.set({
  sessions: [
    { name: "tmux-dock", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/dock-demo"], commands: ["claude"] },
  ],
  sessionWorktrees: { "tmux-dock": ["/Users/e2e/projects/dock-demo"] },
});

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
