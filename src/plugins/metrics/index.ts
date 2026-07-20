import { registerPlugin } from "../../plugin";
import { MetricsDashboardPanel } from "./1_dashboard";

export function registerMetricsPlugin(): void {
  registerPlugin({
    id: "metrics",
    panels: [
      {
        id: "metrics",
        railParent: "rules",
        title: "Metrics",
        icon: "▥",
        iconLabel: "Metrics",
        component: MetricsDashboardPanel,
      },
    ],
  });
}
