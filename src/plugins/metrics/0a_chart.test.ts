import { describe, expect, test } from "vitest";
import { metricChartSpec } from "./0a_chart";

describe("metrics Vega-Lite specification", () => {
  test("declares responsive dimensions and native interaction parameters", () => {
    const spec = metricChartSpec([], 900, 500) as Record<string, unknown>;
    expect({
      width: spec.width,
      height: spec.height,
      autosize: spec.autosize,
      params: spec.params,
    }).toMatchInlineSnapshot(`
      {
        "autosize": {
          "contains": "padding",
          "resize": true,
          "type": "fit-x",
        },
        "height": 455,
        "params": [
          {
            "bind": "scales",
            "name": "timeZoom",
            "select": {
              "encodings": [
                "x",
              ],
              "type": "interval",
            },
          },
          {
            "bind": "legend",
            "name": "visibleSeries",
            "select": {
              "fields": [
                "field",
              ],
              "type": "point",
            },
          },
        ],
        "width": 820,
      }
    `);
  });
});
