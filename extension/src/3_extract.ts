import jsonata from "jsonata";
import type { MatchFields, Rule } from "./0_types";

const expressionCache = new Map<string, ReturnType<typeof jsonata> | null>();

export async function extractResponse(rule: Rule, body: unknown): Promise<MatchFields[]> {
  const extracts = rule.response?.extract;
  if (!extracts) return [{ url: rule.request?.url || rule.url || "" }];
  const fields: MatchFields = {};
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
    if (!expression) continue;
    try {
      const value = await expression.evaluate(body);
      if (value !== undefined) fields[field] = value;
    } catch {
      /* malformed response shape or expression: skip this field */
    }
  }
  return Object.keys(fields).length ? [fields] : [];
}
