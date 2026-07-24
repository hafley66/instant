import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { registerCassPlugin } from "../src/plugins/cass";
import { initRail } from "../src/rail";
import { mountReactDock } from "../src/reactdock";
import { store } from "../src/state";
import { wireContextMenu } from "../src/ctxmenu";

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}

registerPlugin({
  id: "cass-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerCassPlugin();
store.set({
  worktrees: [{
    origin: "/tmp/cass-e2e",
    clone: "/tmp/cass-e2e",
    worktree: "/tmp/cass-e2e",
    branch: "main",
    head: "e2e-fixture",
    is_main: true,
    dirty: true,
  }],
});
mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
