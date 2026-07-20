import jsonata from "jsonata";
import jsonLogic from "json-logic-js";
import type { RulesLogic } from "json-logic-js";
import type { Expression, ExpressionEvaluation, JsonValue } from "./0_types";

export function evaluateJsonLogic(rule: JsonValue, input: JsonValue): JsonValue {
  return jsonLogic.apply(rule as RulesLogic, input) as JsonValue;
}

export async function evaluateJsonata(expression: string, input: JsonValue): Promise<JsonValue> {
  return await jsonata(expression).evaluate(input) as JsonValue;
}

export async function evaluateExpression(expression: Expression, input: JsonValue): Promise<JsonValue> {
  if (expression.language === "json-logic") return evaluateJsonLogic(expression.value, input);
  return evaluateJsonata(expression.value, input);
}

export async function evaluateExpressionWithTrace(
  expression: Expression,
  input: JsonValue,
  path?: string,
): Promise<ExpressionEvaluation> {
  try {
    const value = await evaluateExpression(expression, input);
    const outcome = value === undefined ? "missing" : value === false ? "filtered" : "passed";
    return {
      value,
      trace: { path, language: expression.language, expression: expression.value, outcome, result: value },
    };
  } catch (error) {
    return {
      trace: {
        language: expression.language,
        path,
        expression: expression.value,
        outcome: "error",
        reason: String(error),
      },
    };
  }
}
