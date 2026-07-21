import { defer, map, merge, Observable, scan, shareReplay } from "rxjs";
import type { JsonObject, JsonValue } from "./0_types";
import { AutomationV2Schema, type AutomationV2, type ObservableExpression } from "./8_v2_schema";

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
  origin?: { url: string; ts: number };
};

function sourceOrigin(value: RuntimeSource): LocatedValue["origin"] {
  return { url: "requestUrl" in value ? value.requestUrl : value.url, ts: value.ts };
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

function getOptional(value: JsonValue, pointer: string): JsonValue | undefined {
  try {
    return get(value, pointer);
  } catch {
    return undefined;
  }
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

function flowKey(ref: string, parameters: unknown): string {
  return `${ref}?${JSON.stringify(canonical(parameters ?? {}))}`;
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
        map((inputValue) => {
          const root = get(inputValue.value, expression.project.from);
          return {
            value: Object.fromEntries(
              Object.entries(expression.project.fields).map(([field, path]) => [field, get(root, path)]),
            ),
            origin: inputValue.origin,
          };
        }),
      );
    }
    if ("merge" in expression) {
      return merge(...expression.merge.inputs.map(compileExpression));
    }
    if ("machine" in expression) {
      const definition = automation.circuit.machines[expression.machine.ref];
      if (!definition) throw new Error(`Unknown v2 machine: ${expression.machine.ref}`);
      return compileExpression(expression.machine.input).pipe(
        scan<LocatedValue, LocatedValue>((previous, inputValue) => {
          const event = inputValue.value as JsonObject;
          const eventType = event.type;
          if (typeof eventType !== "string") throw new Error("Machine input requires an event type");
          const transition = definition.on[eventType];
          if (!transition) return { value: previous.value, origin: inputValue.origin };
          const state = previous.value as JsonObject;
          const previousContext = state.context as JsonObject;
          const context = transition.replaceContext
            ? get(inputValue.value, transition.replaceContext)
            : {
                ...previousContext,
                ...Object.fromEntries(Object.entries(transition.patchContext ?? {}).flatMap(([field, path]) => {
                  const value = getOptional(inputValue.value, path);
                  return value === undefined ? [] : [[field, value]];
                })),
              };
          if (typeof context !== "object" || context === null || Array.isArray(context)) {
            throw new Error(`Machine context must be an object: ${expression.machine.ref}`);
          }
          return {
            value: { value: transition.target ?? state.value, context },
            origin: inputValue.origin,
          } satisfies LocatedValue;
        }, {
          value: { value: definition.initial.value, context: definition.initial.context } as unknown as JsonValue,
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
    const key = flowKey(ref, definition.parameters);
    const existing = instances.get(key);
    if (existing) return existing;
    const compiled = compileExpression(definition.expression);
    instances.set(key, compiled);
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
          matches: [located.value as JsonObject],
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
