import type { VisualizationSpec } from "vega-embed";
import type { MetricPoint } from "./0_types";

export function metricChartSpec(data: MetricPoint[], width: number, height: number): VisualizationSpec {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: Math.max(240, width - 80),
    height: Math.max(140, height - 45),
    autosize: { type: "fit-x", contains: "padding", resize: true },
    data: { name: "metrics", values: data },
    params: [
      {
        name: "timeZoom",
        select: {
          type: "interval",
          encodings: ["x"],
        },
        bind: "scales",
      },
      {
        name: "visibleSeries",
        select: { type: "point", fields: ["series"] },
        bind: "legend",
      },
    ],
    mark: { type: "line", point: { filled: true, size: 55 }, clip: true },
    encoding: {
      x: { field: "ts", type: "temporal", title: "time", axis: { format: "%H:%M:%S", labelAngle: 0 } },
      y: { field: "value", type: "quantitative", title: "usage %", scale: { domain: [0, 100] } },
      color: { field: "series", type: "nominal", title: "stream / measure" },
      opacity: { condition: { param: "visibleSeries", value: 1 }, value: 0.15 },
      tooltip: [
        { field: "ts", type: "temporal", title: "time" },
        { field: "stream", type: "nominal", title: "stream" },
        { field: "field", type: "nominal", title: "measure" },
        { field: "value", type: "quantitative", title: "usage", format: ".2f" },
        { field: "ruleId", type: "nominal", title: "rule" },
        { field: "url", type: "nominal", title: "source" },
      ],
    },
  };
}
