import { describe, expect, it } from "vitest";
import { evaluateExpression, evaluateExpressionWithTrace, evaluateJsonLogic, evaluateJsonata } from "./5_expressions";

describe("json-rx expressions", () => {
  const input = {
    state: { value: "checking", usage: 0.86 },
    event: { type: "usage.updated" },
  };

  it("evaluates JSON Logic guards", () => {
    expect(evaluateJsonLogic(
      { ">": [{ "var": "state.usage" }, 0.8] },
      input,
    )).toBe(true);
  });

  it("evaluates JSONata extraction", async () => {
    await expect(evaluateJsonata("state.usage * 100", input)).resolves.toBe(86);
  });

  it("explains a JSON Logic filter result", async () => {
    await expect(evaluateExpressionWithTrace(
      { language: "json-logic", value: { ">": [{ "var": "state.usage" }, 0.8] } },
      { state: { value: "checking", usage: 0.7 } },
      "usage.guard",
    )).resolves.toMatchObject({
      trace: {
        path: "usage.guard",
        language: "json-logic",
        outcome: "filtered",
        result: false,
      },
    });
  });

  it("dispatches by expression language", async () => {
    await expect(evaluateExpression({
      language: "json-logic",
      value: { "var": "state.value" },
    }, input)).resolves.toBe("checking");
  });
});
