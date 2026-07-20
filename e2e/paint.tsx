import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { registerRulesPlugin } from "../src/rules";
import { initRail } from "../src/rail";
import { mountReactDock } from "../src/reactdock";
import { openPaintFile, registerPaint } from "../src/paintPanel";
import { paintSession } from "../src/paintSessions";
import { closeActiveTab, reopenLastTab } from "../src/tabs";
import { installKeymap } from "../src/keymap";

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}

registerPlugin({
  id: "paint-e2e-sessions",
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
registerPaint();
registerRulesPlugin();
paintSession.$({ recent: ["/tmp/paint-second.png"], lastPath: null });
installKeymap([
  { id: "e2e-close", keys: ["$mod+w"], run: closeActiveTab },
  { id: "e2e-reopen", keys: ["$mod+Shift+t"], run: () => void reopenLastTab() },
]);

document.querySelector<HTMLButtonElement>("[data-testid=open-first]")!.onclick = () => {
  openPaintFile("/tmp/paint-first.png");
};
mountReactDock(document.getElementById("dock")!);
initRail();
