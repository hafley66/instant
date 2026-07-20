# Timed events and routines

The next Rule-facing layer can describe event sources and reusable routines as
JSON while retaining RxJS as the timing and concurrency implementation.

## Source algebra

```ts
type EventSource =
  | {
      type: "timer";
      afterMs?: number;
      everyMs?: number;
      event: EventTemplate;
    }
  | {
      type: "input";
      ref: string;
      timing?: EventTiming;
    };

type EventTiming = {
  delayMs?: number;
  debounceMs?: number;
  throttleMs?: number;
};
```

`timer` represents one-shot and repeated sources:

```json
{
  "type": "timer",
  "afterMs": 5000,
  "event": { "type": "routine.start" }
}
```

```json
{
  "type": "timer",
  "afterMs": 0,
  "everyMs": 60000,
  "event": { "type": "routine.tick" }
}
```

The direct lowering is:

```text
timer(afterMs)             -> one event after a delay
timer(afterMs, everyMs)    -> initial event followed by interval events
delayMs                    -> delay(delayMs)
debounceMs                 -> debounceTime(debounceMs)
throttleMs                 -> throttleTime(throttleMs)
```

The timing fields transform an existing source. They do not create separate
schedulers or queues.

## Runtime lifetime

RxJS timers require a live subscription. Chrome Manifest V3 service workers
can be suspended, so durable extension schedules must lower to `chrome.alarms`.
When the alarm fires, it emits the same JSON-Rx event that an in-process RxJS
timer would emit.

```text
declarative timer source
  -> browser host: chrome.alarms
  -> application host: RxJS timer
  -> common Event envelope
  -> routine machine
```

This keeps host lifecycle policy outside the serialized routine.

## Routine definition

```ts
type RoutineDefinition = {
  id: string;
  sources: EventSource[];
  machine: MachineRef;
};
```

Example:

```json
{
  "id": "jenkins.poll",
  "sources": [
    {
      "type": "timer",
      "afterMs": 0,
      "everyMs": 60000,
      "event": { "type": "jenkins.poll" }
    }
  ],
  "machine": { "ref": "jenkins.poll.v1" }
}
```

The referenced machine can emit browser or HTTP effect descriptions. Effect
interpreters remain host plugins. Result events return to the same machine with
the causing event's identity in `causationId`.

## Concurrency selection

Routine definitions eventually need a serializable flattening policy at effect
or subroutine boundaries.

| Policy | RxJS lowering | Behavior on a new event |
| --- | --- | --- |
| `queue` | `concatMap` | queue behind active work |
| `replace` | `switchMap` | unsubscribe previous work |
| `ignore` | `exhaustMap` | discard while active |
| `merge` | `mergeMap` | run concurrently, optionally bounded |

The initial routine implementation can use `queue`, matching the existing
effect feedback loop's globally sequential execution.

## Required interfaces

```ts
function compileSource(source: EventSource): Observable<Event>;

function compileTiming(
  timing: EventTiming,
): OperatorFunction<Event, Event>;

function runRoutine(
  definition: RoutineDefinition,
  catalog: DefinitionCatalog,
  interpreters: EffectInterpreterCatalog,
): RoutineRuntime;
```

Rule-facing integration requires fields equivalent to:

```ts
type RuleAutomation = {
  sources?: EventSource[];
  machine?: MachineRef;
};
```
