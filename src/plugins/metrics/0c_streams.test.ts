import { describe, expect, it } from "vitest";
import { metricPoints, selectedStreams, streamNames } from "./0c_streams";
import type { MetricMatch } from "./0_types";

const rows: MetricMatch[] = [
  { ruleId: "codex", url: "codex://read", ts: 2, stream: "codex.usage", matches: [{ percent: 42, label: "ready" }] },
  { ruleId: "claude", url: "https://claude.ai", ts: 1, stream: "claude.usage", matches: [{ percent: 37 }] },
];

describe("metrics stream derivation", () => {
  it("keeps one stream as the default and accepts at most two stored streams", () => {
    expect({
      names: streamNames(rows),
      default: selectedStreams(streamNames(rows)),
      restored: selectedStreams(streamNames(rows), ["claude.usage", "codex.usage", "unknown"]),
    }).toMatchInlineSnapshot(`
      {
        "default": [
          "codex.usage",
        ],
        "names": [
          "codex.usage",
          "claude.usage",
        ],
        "restored": [
          "claude.usage",
          "codex.usage",
        ],
      }
    `);
  });

  it("creates distinct chart series when fields have the same name", () => {
    expect(metricPoints(rows).map(({ stream, field, series, value }) => ({ stream, field, series, value }))).toMatchInlineSnapshot(`
      [
        {
          "field": "percent",
          "series": "codex.usage · percent",
          "stream": "codex.usage",
          "value": 42,
        },
        {
          "field": "percent",
          "series": "claude.usage · percent",
          "stream": "claude.usage",
          "value": 37,
        },
      ]
    `);
  });
});
