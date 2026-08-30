// App-level harness for the rectangle adapter lab: registers the real rectangle
// plugin beside an ordinary Sessions panel and wires a control button to the
// exported openRectangleWorkspace seam, so the Playwright spec can prove the
// rectangle workspace opens as a Dockview tab beside an existing tab.

import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { initRail } from "../src/rail";
import { mountReactDock } from "../src/reactdock";
import { registerRectangle, openRectangleWorkspace } from "../src/plugins/rectangle";

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}

registerPlugin({
  id: "rectangle-e2e-sessions",
  panels: [
    {
      id: "sessions",
      title: "Sessions",
      icon: "S",
      iconLabel: "Sessions",
      component: SessionsPanel,
    },
  ],
});

registerRectangle();

document.querySelector<HTMLButtonElement>("[data-testid=open-rect]")!.onclick = () => {
  openRectangleWorkspace({
    id: "wk-1",
    title: "Rect Workspace",
    sessions: [
      { id: "s1", title: "session one", lines: ["src/index.ts", "README.md"] },
      { id: "s2", title: "session two", lines: ["src/main.ts"] },
    ],
    graph: {
      id: "g1",
      title: "build graph",
      nodes: ["source", "compile", "run"],
      edges: [
        ["source", "compile"],
        ["compile", "run"],
      ],
    },
  });
};

mountReactDock(document.getElementById("dock")!);
initRail();
