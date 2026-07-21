# JSON-Rx

JSON-Rx is the execution layer used when Instant needs serializable event flow
and explicit state transitions. RxJS supplies time, subscription, concurrency,
and cancellation semantics. JSON-Rx supplies JSON-shaped events, state,
updates, effects, expression descriptions, machine instances, and reusable
references.

This library is the current implementation slice. The specification direction
is documented in
[`books/json-rx-automation/4_json-rx-specification-synthesis.md`](../../../books/json-rx-automation/4_json-rx-specification-synthesis.md).
That design treats named flows as the public programs, host and portable
sources as Observable constructors, machines as recurrence that can lower to
`scan`, sharing through `share` and `shareReplay`, and application consumption
through host subscriptions. It also separates scheduler policy from demand,
queue bounds, and backpressure so a later Rust implementation can use
`futures::Stream` and `StreamExt` rather than an all-push Rx runtime.

## Public algebra

All public data types live in `0_types.ts`.

```text
Event<A>       = { type, data: A, time?, id?, partitionKey?, causationId? }
State          = { value, ...fields }
StateUpdate    = Replace(State) | Patch(JsonPatch[]) | Set(JSONPointer, Value)
Effect         = { op, input?, timeoutMs?, retry? }
Transition     = { updates?, events?, effects? }
Machine        = { initial, transition(State, Event) -> Transition }
Flow           = Observable<Event> -> Observable<Event>
MachineRef     = { ref }
FlowRef        = { ref }
```

`State.value` is the current control value. The remaining fields are the
instance context. A transition is synchronous and pure when its supplied
`transition` function is pure. Effects are descriptions returned alongside the
next state. An outer interpreter owns their execution.

## Dependency and reading order

```text
0_types.ts
  <- 1_state.ts
  <- 2_machine.ts
  <- 3_instances.ts
  <- 4_operators.ts
  <- 5_expressions.ts
  <- 6_catalog.ts
  <- 7_effects.ts
```

- `1_state.ts` applies immutable replace, JSON Patch, and JSON Pointer set
  updates.
- `2_machine.ts` lowers a machine to RxJS `scan`.
- `3_instances.ts` uses `groupBy` and `mergeMap` to create one machine timeline
  per partition key.
- `4_operators.ts` exports RxJS combinators directly. Operator behavior and
  cancellation remain RxJS behavior.
- `5_expressions.ts` dispatches JSON Logic and JSONata and emits structured
  expression traces.
- `6_catalog.ts` resolves reusable machine and flow definitions by reference.
- `7_effects.ts` owns the feedback loop from machine effects through an
  asynchronous interpreter and back into the same machine as events.

## Machine lowering

Type signature:

```ts
runMachine(
  events$: Observable<Event>,
  machine: Machine,
): Observable<MachineEmission>
```

Body shape:

```ts
events$.pipe(
  scan((previous, event) => {
    // Evaluate exactly one transition against the previous state.
    // Apply updates in declared order.
    // Preserve emitted event and effect descriptions for the interpreter.
    return emission;
  }, machine.initial),
)
```

Instance timeline:

```text
subscribe
  -> initial state allocated for this subscription
event A
  -> transition(initial, A)
  -> updates folded left to right
  -> emission A
event B
  -> transition(state A, B)
  -> emission B
unsubscribe
  -> RxJS subscription and upstream work disposed
```

`runPartitionedMachine` changes the lifetime boundary:

```text
events$
  -> groupBy(partitionKey)
  -> key A: one scan and one state instance
  -> key B: one scan and one state instance
  -> mergeMap(all instance emissions)
```

The partition key supplies instance identity. A machine definition supplies
construction. The catalog resolves a reusable definition before each grouped
timeline is run.

## Reads, writes, and uniqueness

State is held inside the RxJS `scan` accumulator. Each input event performs one
read of the previous state and produces one next state. Updates are immutable
JSON values. JSON Pointer paths identify fields. Arrays use numeric path
segments and `-` for append.

The library has no persistence. A subscriber, effect interpreter, or host owns
storage. Event `id` and `causationId` are transport fields; the runtime does not
deduplicate them. `partitionKey` identifies a machine instance only when the
partitioned runner is used.

## Concurrency and pressure

Concurrency is selected at the flow boundary with RxJS operators:

| Operator | Active inner work | New outer event |
| --- | ---: | --- |
| `concatMap` | 1 | queued |
| `exhaustMap` | 1 | ignored while active |
| `switchMap` | 1 | previous inner subscription cancelled |
| `mergeMap` | multiple | merged; optional concurrency bound belongs in the operator |

JSON-Rx does not add a second scheduler or queue. The selected Observable and
operator define push/pull behavior, cancellation, buffering, and terminal
`next/error/complete` behavior.

## Effect feedback loop

```ts
createEffectMachineRuntime(machine, interpret)
  -> { emissions$, dispatch(event), close() }
```

```text
dispatch Event
  -> runMachine / scan
  -> Transition.effects
  -> concatMap effects in declared order
  -> interpreter(effect, causingEvent)
  -> result Event with causationId
  -> same machine input
```

Effects are globally sequential within one runtime. Input events arriving while
an effect is active remain subject to the source Observable's push semantics;
effect work itself is queued by `concatMap`. Interpreter failures become
`effect.error` events and also re-enter the machine.

## Expressions and diagnostics

```ts
evaluateExpressionWithTrace(expression, input, path?)
  -> { value?, trace }
```

Trace outcomes are `passed`, `filtered`, `missing`, or `error`. The trace
records language, expression, logical path, result, and failure reason. JSON
Logic is used for predicates and guards. JSONata is used for projection and
object construction.

## Current Instant consumer

`src/plugins/metrics/2_runtime.ts` creates a polling Observable with
`timer -> exhaustMap -> native invoke`. Success and failure become ordinary
events. `runMachine` reduces those events into `{ value, rows, error }`.
The dashboard subscribes once on mount and unsubscribes on unmount.

The extension's `5_scheduleRuntime.ts` is the first effect-loop consumer. Alarm
ticks become `schedule.tick` events, the schedule machine emits browser effects,
and browser result events re-enter that machine. Metrics uses the machine and
operator portions. Partitioned instances and catalog references remain
available for workflows that need them.
