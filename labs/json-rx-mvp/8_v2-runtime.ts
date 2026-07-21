import { Observable, defer, map, shareReplay } from "rxjs";
import type { JsonObject, JsonValue } from "./0_types";
import { instanceUrl } from "./1_identity";
import {
  AutomationV2Schema,
  type AutomationV2,
  type ObservableExpression,
} from "./7_v2-schema";

export type NetworkResponse = {
  method: string;
  pageUrl: string;
  requestUrl: string;
  status: number;
  ts: number;
  body: JsonValue;
};

export type DashboardEmission = {
  ruleId: string;
  url: string;
  ts: number;
  matches: JsonObject[];
  stream: string;
  schema: Record<string, unknown>;
};

export type AutomationV2Runtime = {
  automation: AutomationV2;
  roots: Record<string, Observable<DashboardEmission>>;
  canonicalIr: string;
};

type LocatedValue = {
  value: JsonValue;
  origin?: {
    url: string;
    ts: number;
  };
};

function get(value: JsonValue, pointer: string): JsonValue {
  let current = value;
  for (const segment of pointer.slice(2).split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Path did not resolve: ${pointer}`);
    }
    current = current[segment];
  }
  if (current === undefined) throw new Error(`Path did not resolve: ${pointer}`);
  return current;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function compileAutomationV2(
  input: unknown,
  sources: Record<string, Observable<NetworkResponse>>,
): AutomationV2Runtime {
  const automation = AutomationV2Schema.parse(input);
  const instances = new Map<string, Observable<LocatedValue>>();

  const compileExpression = (expression: ObservableExpression): Observable<LocatedValue> => {
    if ("source" in expression) {
      return defer(() => {
        const source = sources[expression.source.ref];
        if (!source) throw new Error(`Missing source runtime binding: ${expression.source.ref}`);
        return source.pipe(map((response) => ({
          value: response as unknown as JsonValue,
          origin: { url: response.requestUrl, ts: response.ts },
        })));
      });
    }
    if ("project" in expression) {
      return compileExpression(expression.project.input).pipe(
        map((input) => {
          const root = get(input.value, expression.project.from);
          return {
            value: Object.fromEntries(
              Object.entries(expression.project.fields).map(([field, path]) => [field, get(root, path)]),
            ),
            origin: input.origin,
          };
        }),
      );
    }
    return compileExpression(expression.shareReplay.input).pipe(
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  };

  const flow = (ref: string): Observable<LocatedValue> => {
    const definition = automation.circuit.flows[ref];
    if (!definition) throw new Error(`Unknown v2 flow: ${ref}`);
    const id = instanceUrl(ref, definition.parameters);
    const existing = instances.get(id);
    if (existing) return existing;
    const compiled = compileExpression(definition.expression);
    instances.set(id, compiled);
    return compiled;
  };

  const roots = Object.fromEntries(automation.outputs.map((output) => [
    output.stream,
    flow(output.flow).pipe(
      map((located): DashboardEmission => {
        if (typeof located.value !== "object" || located.value === null || Array.isArray(located.value)) {
          throw new Error(`Dashboard flow must emit an object: ${output.flow}`);
        }
        return {
          ruleId: automation.id,
          url: located.origin?.url ?? output.flow,
          ts: located.origin?.ts ?? 0,
          matches: [located.value],
          stream: output.stream,
          schema: output.schema,
        };
      }),
    ),
  ]));

  return {
    automation,
    roots,
    canonicalIr: JSON.stringify(canonical(automation)),
  };
}
