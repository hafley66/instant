import jsonata from "jsonata";
import type { ExpressionTrace, MatchFields, Rule } from "./0_types";

const expressionCache = new Map<string, ReturnType<typeof jsonata> | null>();

export async function extractResponseDetailed(
  rule: Rule,
  body: unknown,
): Promise<{ matches: MatchFields[]; traces: ExpressionTrace[] }> {
  const extracts = rule.response?.extract;
  if (!extracts) return { matches: [{ url: rule.request?.url || rule.url || "" }], traces: [] };
  const fields: MatchFields = {};
  const traces: ExpressionTrace[] = [];
  const mode = rule.diagnostics ?? "off";
  const trace = (entry: ExpressionTrace) => {
    if (mode === "all" || (mode === "errors" && entry.outcome !== "passed")) traces.push(entry);
  };
  for (const [field, source] of Object.entries(extracts)) {
    let expression = expressionCache.get(source);
    if (expression === undefined) {
      try {
        expression = jsonata(source);
      } catch {
        expression = null;
      }
      expressionCache.set(source, expression);
    }
    if (!expression) {
      trace({
        ruleId: rule.id,
        phase: "extract",
        path: field,
        language: "jsonata",
        expression: source,
        outcome: "error",
        reason: "invalid JSONata expression",
      });
      continue;
    }
    try {
      const value = await expression.evaluate(body);
      if (value !== undefined) {
        fields[field] = value;
        trace({ ruleId: rule.id, phase: "extract", path: field, language: "jsonata", expression: source, outcome: "passed", result: value });
      } else {
        trace({ ruleId: rule.id, phase: "extract", path: field, language: "jsonata", expression: source, outcome: "missing", reason: "expression returned undefined" });
      }
    } catch (error) {
      trace({
        ruleId: rule.id,
        phase: "extract",
        path: field,
        language: "jsonata",
        expression: source,
        outcome: "error",
        reason: String(error),
      });
    }
  }
  return { matches: Object.keys(fields).length ? [fields] : [], traces };
}

export async function extractResponse(rule: Rule, body: unknown): Promise<MatchFields[]> {
  return (await extractResponseDetailed(rule, body)).matches;
}
