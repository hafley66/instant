import type { Observable } from "rxjs";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type JsonError = {
  code: string;
  message: string;
  details?: JsonValue;
};

export type Notification<Value extends JsonValue = JsonValue> =
  | { kind: "next"; value: Value }
  | { kind: "error"; error: JsonError }
  | { kind: "complete" };

export type ParameterSchema = {
  type: "boolean" | "integer" | "number" | "string";
  default?: JsonPrimitive;
};

export type ParametersSchema = {
  path?: Record<string, ParameterSchema>;
  query?: Record<string, ParameterSchema>;
};

export type ParameterBinding =
  | JsonPrimitive
  | { get: string };

export type SourceExpression = {
  node: string;
  source: {
    ref: string;
  };
};

export type OfExpression = {
  node: string;
  of: JsonValue[];
};

export type MapExpression = {
  node: string;
  map: {
    input: ObservableExpression;
    get: string;
  };
};

export type SwitchMapExpression = {
  node: string;
  switchMap: {
    input: ObservableExpression;
    ref: string;
    path?: Record<string, ParameterBinding>;
    query?: Record<string, ParameterBinding>;
  };
};

export type ShareReplayExpression = {
  node: string;
  shareReplay: {
    input: ObservableExpression;
    bufferSize: 1;
    refCount: true;
  };
};

export type ObservableExpression =
  | SourceExpression
  | OfExpression
  | MapExpression
  | SwitchMapExpression
  | ShareReplayExpression;

export type FlowDefinition = {
  parameters?: ParametersSchema;
  expression: ObservableExpression;
};

export type SourceDefinition = {
  parameters?: ParametersSchema;
};

export type JsonRxDocument = {
  jsonRx: "0.1-lab";
  profile: "rxjs-7.8";
  sources: Record<string, SourceDefinition>;
  flows: Record<string, FlowDefinition>;
};

export type InstanceParameters = {
  path?: Record<string, JsonPrimitive>;
  query?: Record<string, JsonPrimitive>;
};

export type SourceBinding = (instance: URL) => Observable<JsonValue>;

export type RuntimeTrace = {
  sequence: number;
  outcome: "flow.subscribe" | "flow.unsubscribe" | "source.acquire" | "source.release";
  instance: string;
  node?: string;
};

export type CompiledRuntime = {
  flow(ref: string, parameters?: InstanceParameters): Observable<JsonValue>;
  materialize(ref: string, parameters?: InstanceParameters): Observable<Notification>;
  traces: RuntimeTrace[];
};
