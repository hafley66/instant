import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { AutomationV2JsonSchema, AutomationV2Schema } from "./8_v2_schema";

const source = "jsonrx://test/source";
const flow = "jsonrx://test/flow";
const reducer = "jsonrx://test/reducer";

function document() {
  return {
    version: "automation.v2",
    profile: "rxjs-7.8",
    id: "jsonrx://test/automation",
    bindings: { sources: { [source]: { kind: "host.event", operation: "test/read" } } },
    circuit: {
      sources: { [source]: {} },
      flows: {
        [flow]: {
          expression: { node: "test.source", source: { ref: source } },
        },
      },
    },
    outputs: [{ kind: "instant.dashboard.emit", flow, stream: "test.stream", schema: { type: "object" } }],
  };
}

describe("automation.v2 schema", () => {
  it("applies defaults and exposes Draft 2020-12 JSON Schema", () => {
    const parsed = AutomationV2Schema.parse(document());
    expect({ enabled: parsed.enabled, reducerKeys: Object.keys(parsed.circuit.reducers), schemaId: AutomationV2JsonSchema.$schema }).toMatchInlineSnapshot(`
      {
        "enabled": true,
        "reducerKeys": [],
        "schemaId": "https://json-schema.org/draft/2020-12/schema",
      }
    `);
  });

  it("rejects a circuit source without a host binding", () => {
    const input = document();
    const invalid = { ...input, bindings: { sources: {} } };
    expect(() => AutomationV2Schema.parse(invalid)).toThrow(ZodError);
  });

  it("validates a reusable scan reducer", () => {
    const input = document();
    const parsed = AutomationV2Schema.parse({
      ...input,
      circuit: {
        ...input.circuit,
        reducers: {
          [reducer]: {
            seed: { count: 0, label: null },
            cases: {
              snapshot: { replace: "$.data" },
              update: { patch: { count: "$.data.count" } },
            },
          },
        },
        flows: {
          [flow]: {
            expression: {
              node: "test.scan",
              scan: {
                reducer: { ref: reducer },
                input: { node: "test.source", source: { ref: source } },
              },
            },
          },
        },
      },
    });

    expect({
      expression: parsed.circuit.flows[flow].expression,
      reducer: parsed.circuit.reducers[reducer],
    }).toMatchInlineSnapshot(`
      {
        "expression": {
          "node": "test.scan",
          "scan": {
            "input": {
              "node": "test.source",
              "source": {
                "ref": "jsonrx://test/source",
              },
            },
            "reducer": {
              "ref": "jsonrx://test/reducer",
            },
          },
        },
        "reducer": {
          "cases": {
            "snapshot": {
              "replace": "$.data",
            },
            "update": {
              "patch": {
                "count": "$.data.count",
              },
            },
          },
          "seed": {
            "count": 0,
            "label": null,
          },
        },
      }
    `);
  });
});
