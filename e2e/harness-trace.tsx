import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { registerHarnessTracePlugin } from "../src/plugins/harnessTrace";
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
  id: "trace-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerHarnessTracePlugin();
store.set({
  worktrees: [{
    origin: "/Users/e2e/projects/sprefa",
    clone: "/Users/e2e/projects/sprefa",
    worktree: "/Users/e2e/projects/sprefa",
    branch: "main",
    head: "e2e-fixture",
    is_main: true,
    dirty: false,
  }],
});
mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
