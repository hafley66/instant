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

## Deferred shell command contract

A future Sprefa adapter needs a controlled, serializable command description
for Ansible-like routines. Shell execution is a duplex temporal process, so it
should integrate as a first-class JSON-Rx stream rather than being reduced to
one promise and one result event. The authoring form may resemble a line of
shell, but dynamic values must remain distinguishable from trusted template
text so the interpreter can quote, validate, redact, and audit them before
execution.

The portable contract describes the stream ports and lifecycle. Each host
defines whether and how it can lower that contract to a local process, remote
runner, container, SSH session, or another executor.

```text
invocation and stdin events
  -> host shell interpreter
  -> started | stdout | stderr | exited | failed events
```

The future interpreter boundary therefore returns an observable lifecycle:

```ts
type StreamingEffectInterpreter = (
  effect: ShellEffect,
  cause: Event,
) => Observable<Event>;
```

Cancellation unsubscribes from the lifecycle and asks the host to terminate
the execution. Output events retain invocation identity and sequence metadata
so consumers can merge streams while reconstructing each process in order.
Hosts also define buffering, overflow, line versus byte framing, and whether
stdin is available after startup.

The contract should preserve Sprefa's existing `sh` and `sh*` distinction
rather than defining another process model in Instant. Before implementation,
the design needs to record their exact semantics and settle:

- command template versus argument-vector representation
- typed template inputs and allowed coercions
- quoting and shell selection
- environment and working-directory declarations
- secret references and diagnostic redaction
- timeout, cancellation, exit status, stdout, and stderr events
- stdin, line or byte framing, buffering, and backpressure policy
- single-command versus expanded or repeated-command cardinality
- capability policy controlling which host may interpret the effect

JSON-Rx would carry the effect description, input stream, lifecycle, and output
events. Sprefa would validate and execute the command. Instant would author,
schedule, observe, and render the routine without acquiring a shell
implementation.

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
