# Portable JSON-Rx runtime boundary

JSON-Rx is intended to move between browser extensions, web applications,
Node.js processes, Tauri applications, tests, and other JavaScript hosts. Its
public algebra therefore contains descriptions of computation rather than host
APIs.

## Portable layer

The reusable package owns:

- JSON event envelopes
- state and state-update descriptions
- machine transitions
- routine and source descriptions
- reusable machine and flow references
- expression descriptions
- effect descriptions
- RxJS lowering and concurrency semantics
- interpreter interfaces
- structured diagnostics

The portable layer does not import Chrome, Tauri, Node process APIs, database
clients, HTTP clients, WebSocket clients, LSP clients, or application panels.

```text
JSON definitions
  -> JSON-Rx compiler
  -> RxJS Observable graph
  -> events, state emissions, effect descriptions
```

## Host layer

A host supplies source and effect interpreters:

```ts
type SourceInterpreter = (
  source: EventSource,
) => Observable<Event>;

type EffectInterpreter = (
  effect: Effect,
  cause: Event,
) => Promise<Event>;
```

Examples:

| Description | Browser host | Application host | Sprefa host |
| --- | --- | --- | --- |
| repeated timer | `chrome.alarms` | RxJS `timer` | scheduled source |
| tab reload | `chrome.tabs.reload` | unsupported | unsupported |
| persisted row | localhost ingest | Tauri command | relation or adapter |
| shell/process | unsupported | unsupported | Sprefa effect |
| HTTP/WebSocket/LSP | observed page traffic only | unsupported | Sprefa source/effect |

Unsupported host operations remain valid descriptions only when the host can
reject them with a structured error event. Hosts do not silently ignore an
effect.

## Application adapters

Instant contributes adapters around JSON-Rx:

```text
Chrome page and extension sources
  -> normalized JSON-Rx events
  -> portable routine or machine
  -> dashboard emission
  -> Instant persistence
  -> schema-driven Metrics rendering
```

Sprefa can contribute shell, process, HTTP, WebSocket, LSP, and other external
sources while emitting the same event or dashboard envelopes. Their transport
implementation remains outside Instant and JSON-Rx.

## Package dependency direction

```text
json-rx types
  <- state and machine runtime
  <- source/effect compiler interfaces
  <- host adapters
  <- Instant Rules and Metrics
  <- service-specific rule definitions
```

Imports point toward the portable package. The portable package does not import
its consumers.

## Serialization boundary

Pure TypeScript transition functions remain useful for the reference runtime,
but they are not portable serialized programs. A portable routine definition
must encode transitions through stable operation names, expressions, updates,
events, effects, and references.

```ts
type SerializableTransition = {
  guard?: Expression;
  updates?: StateUpdate[];
  events?: EventTemplate[];
  effects?: Effect[];
};
```

The TypeScript reference implementation compiles these descriptions into RxJS
operators and machine transition functions. Another implementation can compile
the same JSON into Rust streams or another reactive runtime while preserving
event ordering, state-update order, flattening policy, errors, and completion.
