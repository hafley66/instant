export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Expression =
  | { language: "json-logic"; value: JsonValue }
  | { language: "jsonata"; value: string };

export type ExpressionTrace = {
  language: Expression["language"];
  path?: string;
  expression: JsonValue | string;
  outcome: "passed" | "filtered" | "missing" | "error";
  result?: JsonValue;
  reason?: string;
};

export type ExpressionEvaluation = {
  value?: JsonValue;
  trace: ExpressionTrace;
};

export type Event<Data extends JsonValue = JsonValue> = {
  type: string;
  data: Data;
  time?: number;
  id?: string;
  partitionKey?: string;
  causationId?: string;
};

export type State = {
  value: string;
  [key: string]: JsonValue;
};

export type JsonPatchOperation =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

export type StateUpdate =
  | { op: "replace"; state: State }
  | { op: "patch"; patch: JsonPatchOperation[] }
  | { op: "set"; path: string; value: JsonValue };

export type Effect = {
  id?: string;
  op: string;
  input?: JsonValue;
  timeoutMs?: number;
  retry?: {
    maxAttempts: number;
    backoffMs?: number;
  };
};

export type Transition = {
  updates?: StateUpdate[];
  events?: Event[];
  effects?: Effect[];
};

export type Machine = {
  initial: State;
  transition: (state: State, event: Event) => Transition;
};

export type MachineDefinition = {
  id: string;
  create: () => Machine;
};

export type FlowDefinition = {
  id: string;
  run: (events$: Observable<Event>) => Observable<Event>;
};

export type FlowRef = {
  ref: string;
};

export type MachineEmission = {
  event: Event;
  state: State;
  events: Event[];
  effects: Effect[];
};

export type EffectInterpreter = (effect: Effect, cause: Event) => Promise<Event>;

export type EffectMachineRuntime = {
  emissions$: Observable<MachineEmission>;
  dispatch: (event: Event) => void;
  close: () => void;
};
import type { Observable } from "rxjs";
