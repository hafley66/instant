import { registerPlugin } from "../../plugin";
import { HarnessTracePanel } from "./HarnessTracePanel";
import { DockStripPanel } from "./DockStripPanel";

export function registerHarnessTracePlugin(): void {
  registerPlugin({
    id: "harness-trace",
    panels: [
      {
        id: "harness-trace",
        title: "Harness Trace",
        icon: "⛓",
        iconLabel: "harness trace",
        component: HarnessTracePanel,
      },
      {
        id: "dock-strip",
        title: "Dock Strip",
        icon: "▤",
        iconLabel: "dock strip",
        component: DockStripPanel,
        // Bottom strip: mounts in its own bottom group spanning the workspace
        // (toggleStripPanel), sized by the persisted dock-strip height.
        bottomStrip: true,
        keepAlive: true,
      },
    ],
  });
}
