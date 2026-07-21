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

export {
  CODEX_HOST_STATUS,
  claudeUsageV1,
  claudeUsageV2,
  codexUsageSchema,
  codexUsageV2,
  compileCodexUsage,
} from "./1_v2_definitions";
