import { registerPlugin } from "../../plugin";
import { HarnessTracePanel } from "./HarnessTracePanel";

export function registerHarnessTracePlugin(): void {
  registerPlugin({
    id: "harness-trace",
    panels: [{
      id: "harness-trace",
      title: "Harness Trace",
      icon: "⛓",
      iconLabel: "harness trace",
      component: HarnessTracePanel,
    }],
  });
}
