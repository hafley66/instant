import {
  Observable,
  catchError,
  map,
  materialize,
  of,
  shareReplay,
  switchMap,
} from "rxjs";
import type {
  CompiledRuntime,
  InstanceParameters,
  JsonError,
  JsonRxDocument,
  JsonValue,
  Notification,
  ObservableExpression,
  RuntimeTrace,
  SourceBinding,
} from "./0_types";
import { bindParameters, instanceUrl } from "./1_identity";

function jsonError(error: unknown): JsonError {
  if (error instanceof Error) return { code: error.name, message: error.message };
  return { code: "UnknownError", message: String(error) };
}

function get(input: JsonValue, pointer: string): JsonValue {
  if (!pointer.startsWith("$.")) throw new Error(`Only $.field expressions are supported: ${pointer}`);
  let value = input;
  for (const segment of pointer.slice(2).split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Expression path did not resolve: ${pointer}`);
    }
    value = value[segment];
  }
  if (value === undefined) throw new Error(`Expression path did not resolve: ${pointer}`);
  return value;
}

export function compileRuntime(
  document: JsonRxDocument,
  sourceBindings: Record<string, SourceBinding>,
): CompiledRuntime {
  if (document.profile !== "rxjs-7.8") throw new Error(`Unsupported profile: ${document.profile}`);

  const traces: RuntimeTrace[] = [];
  const instances = new Map<string, Observable<JsonValue>>();
  let sequence = 0;
  const trace = (outcome: RuntimeTrace["outcome"], instance: string, node?: string) => {
    traces.push({
      sequence: sequence++,
      outcome,
      instance,
      ...(node === undefined ? {} : { node }),
    });
  };

  const source = (ref: string, node: string, parameters: InstanceParameters): Observable<JsonValue> => {
    const definition = document.sources[ref];
    if (!definition) throw new Error(`Unknown source definition: ${ref}`);
    const binding = sourceBindings[ref];
    if (!binding) throw new Error(`Missing source binding: ${ref}`);
    const instance = instanceUrl(ref, definition.parameters, parameters);
    return new Observable((subscriber) => {
      trace("source.acquire", instance, node);
      const subscription = binding(new URL(instance)).subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        trace("source.release", instance, node);
      };
    });
  };

  const compileExpression = (
    expression: ObservableExpression,
    parameters: InstanceParameters,
  ): Observable<JsonValue> => {
    if ("source" in expression) return source(expression.source.ref, expression.node, parameters);
    if ("of" in expression) return of(...expression.of);
    if ("map" in expression) {
      return compileExpression(expression.map.input, parameters).pipe(
        map((value) => get(value, expression.map.get)),
      );
    }
    if ("switchMap" in expression) {
      return compileExpression(expression.switchMap.input, parameters).pipe(
        switchMap((value) => flow(
          expression.switchMap.ref,
          bindParameters(expression.switchMap, value),
        )),
      );
    }
    return compileExpression(expression.shareReplay.input, parameters).pipe(
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  };

  const flow = (ref: string, parameters: InstanceParameters = {}): Observable<JsonValue> => {
    const definition = document.flows[ref];
    if (!definition) throw new Error(`Unknown flow definition: ${ref}`);
    const instance = instanceUrl(ref, definition.parameters, parameters);
    const existing = instances.get(instance);
    if (existing) return existing;

    const expression$ = compileExpression(definition.expression, parameters);
    const compiled = new Observable<JsonValue>((subscriber) => {
      trace("flow.subscribe", instance);
      const subscription = expression$.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        trace("flow.unsubscribe", instance);
      };
    });
    instances.set(instance, compiled);
    return compiled;
  };

  const materialized = (
    ref: string,
    parameters: InstanceParameters = {},
  ): Observable<Notification> => flow(ref, parameters).pipe(
    materialize(),
    map((notification): Notification => {
      if (notification.kind === "N") return { kind: "next", value: notification.value ?? null };
      if (notification.kind === "E") return { kind: "error", error: jsonError(notification.error) };
      return { kind: "complete" };
    }),
    catchError((error) => of({ kind: "error", error: jsonError(error) } as const)),
  );

  return { flow, materialize: materialized, traces };
}
