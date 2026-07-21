import jsonata from "jsonata";
import { Observable, concatMap, defer, from, map, merge, scan, shareReplay } from "rxjs";
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

export type HostEvent = {
  type: string;
  data: JsonValue;
  url: string;
  ts: number;
};

export type RuntimeSource = NetworkResponse | HostEvent;

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

function sourceOrigin(value: RuntimeSource): LocatedValue["origin"] {
  return {
    url: "pageUrl" in value ? value.pageUrl : value.url,
    ts: value.ts,
  };
}

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
  sources: Record<string, Observable<RuntimeSource>>,
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
          origin: sourceOrigin(response),
        })));
      });
    }
    if ("project" in expression) {
      return compileExpression(expression.project.input).pipe(
        concatMap((input) => {
          const root = get(input.value, expression.project.from);
          return from(Promise.all(Object.entries(expression.project.fields).map(async ([field, source]) => {
            const value = await jsonata(source).evaluate(root);
            return value === undefined ? [] as const : [field, value] as const;
          }))).pipe(map((entries) => ({
            value: Object.fromEntries(entries.filter((entry) => entry.length === 2)) as JsonValue,
            origin: input.origin,
          })));
        }),
      );
    }
    if ("merge" in expression) {
      return merge(...expression.merge.inputs.map(compileExpression));
    }
    if ("scan" in expression) {
      const definition = automation.circuit.reducers[expression.scan.reducer.ref];
      if (!definition) throw new Error(`Unknown v2 reducer: ${expression.scan.reducer.ref}`);
      return compileExpression(expression.scan.input).pipe(
        scan<LocatedValue, LocatedValue>((previous, input) => {
          const event = input.value as JsonObject;
          const eventType = event.type;
          if (typeof eventType !== "string") throw new Error("Scan input requires an event type");
          const reducerCase = definition.cases[eventType];
          if (!reducerCase) return { value: previous.value, origin: input.origin };
          const previousAccumulator = previous.value as JsonObject;
          const accumulator = reducerCase.replace
            ? get(input.value, reducerCase.replace)
            : {
                ...previousAccumulator,
                ...Object.fromEntries(
                  Object.entries(reducerCase.patch ?? {}).flatMap(([field, path]) => {
                    try {
                      return [[field, get(input.value, path)]];
                    } catch {
                      return [];
                    }
                  }),
                ),
              };
          if (typeof accumulator !== "object" || accumulator === null || Array.isArray(accumulator)) {
            throw new Error(`Scan accumulator must be an object: ${expression.scan.reducer.ref}`);
          }
          return {
            value: accumulator,
            origin: input.origin,
          } satisfies LocatedValue;
        }, {
          value: definition.seed as unknown as JsonValue,
          origin: undefined,
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
