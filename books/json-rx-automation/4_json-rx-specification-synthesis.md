# JSON-Rx specification synthesis

## Purpose

JSON-Rx describes named temporal programs in JSON. Its operator model follows
ReactiveX closely enough that an RxJS implementation can be the executable
reference, while its host contract leaves room for Rust `Stream`, Reactive
Streams demand, browser events, durable schedules, shell processes, and other
runtime-specific sources.

The document has the same broad role for flows that OpenAPI has for routes:

```text
OpenAPI
  shared schemas
  named operations at routes
  external HTTP servers and security bindings

JSON-Rx
  shared schemas
  named observable flows
  external observable sources and host bindings
```

The portable document specifies composition and observable behavior. A host
chooses implementations for external sources and capabilities, subscribes to
named flows, and decides what application work consumes their emissions.

## Vocabulary established in this discussion

| Term | Meaning |
| --- | --- |
| schema | JSON Schema describing values or event data |
| event | a typed value carrying an occurrence through a flow |
| source | a declaration for a new Observable supplied by the runtime or host |
| flow | a named Observable expression or pipe |
| pipe | an ordered chain in which each operator receives the prior Observable |
| operator | a transformation from one or more Observables to an Observable |
| ref | a stable reference to a schema, source, flow, expression, or host operation |
| subscription | one running instance of a flow requested by a host or parent operator |
| host | the environment that lowers sources and operations to browser, Node, Rust, Tauri, or other facilities |
| scheduler | policy for when and where work executes |
| demand | downstream permission or readiness for additional values |
| share | multicast one upstream subscription among downstream subscriptions |
| shareReplay | share plus bounded replay using ReactiveX semantics |
| scan | recurrence in which each next output depends on the previous output and current input |
| tap | observation of flow notifications or subscription lifecycle without changing the value channel |

Terms with established ReactiveX meanings keep those meanings. In particular:

- `share` and `shareReplay` describe sharing.
- `materialize` converts `next`, `error`, and `complete` notifications into
  ordinary values.
- A named flow emits by participating in the Observable protocol; an `emit`
  sink operator is not required.
- Application subscription wiring is host code rather than a portable
  `connections` section.

## Authoring directives

JSON-Rx should preserve two complementary forms of compression.

### Flat normalized definitions

Schemas, events, sources, expressions, reusable operator bodies, and flows get
stable names in top-level maps. References replace repeated inline structure.

```json
{
  "schemas": {
    "CodexUsage": {}
  },
  "events": {
    "CodexUsageObserved": {}
  },
  "sources": {
    "panel.visibility": {}
  },
  "flows": {
    "codex.usage.whileVisible": {},
    "codex.usage": {}
  }
}
```

This is document normalization: one definition, stable references, and a large
searchable reference surface for humans, TypeScript, Rust, and generated tools.

### Point-free pipes

Pipe stages should reference reusable functions, expressions, flows, and host
operations when an inline body would repeat implementation detail:

```json
{
  "pipe": [
    { "source": "panel.visibility" },
    { "map": { "ref": "visibility.isVisible" } },
    { "distinctUntilChanged": {} },
    { "switchMap": { "flow": "codex.usage.forVisibility" } },
    { "shareReplay": { "bufferSize": 1, "refCount": true } }
  ]
}
```

The data dependencies stay visible as a short operator chain. Named refs keep
the pipe serializable without forcing JSONata or JSON Logic inline at every
stage. Inline forms remain available for one-use expressions.

ReactiveX names and behavior are the default. JSON-Rx should add vocabulary
only for serialization, references, host capabilities, diagnostics, or a
runtime semantic that ReactiveX does not already name. A TypeScript reader
should be able to translate a flow mechanically into an RxJS `pipe`.

## Minimal document anatomy

The draft top-level shape is:

```json
{
  "jsonRx": "0.1",
  "$schema": "https://example.invalid/json-rx/0.1/schema",
  "schemas": {},
  "events": {},
  "sources": {},
  "flows": {}
}
```

Each map gives reusable definitions stable names. JSON Schema `$ref` remains
the type-reference mechanism. JSON-Rx references resolve executable temporal
definitions.

```text
schemas
  define value shapes

events
  name occurrence envelopes using schemas

sources
  introduce time and external values

flows
  compose sources and other flows through operators
```

Machines, dashboards, browser rules, and shell commands can be vocabularies or
authoring layers that lower into this core. They do not need separate runtime
species when ordinary flows and operators preserve their semantics.

## Schemas and events

JSON Schema Draft 2020-12 provides structural validation, references,
annotations, dialect declaration, and extension vocabularies. JSON-Rx should
reuse it rather than create another type language.

```json
{
  "schemas": {
    "Visibility": {
      "type": "object",
      "required": ["visible"],
      "properties": {
        "visible": { "type": "boolean" }
      }
    },
    "CodexUsage": {
      "type": "object",
      "required": ["primary_percent"],
      "properties": {
        "primary_percent": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 100
        },
        "primary_resets_at": {
          "type": ["string", "null"],
          "format": "date-time"
        }
      }
    }
  },
  "events": {
    "PanelVisibility": {
      "type": "panel.visibility",
      "data": { "$ref": "#/schemas/Visibility" }
    },
    "CodexUsageObserved": {
      "type": "codex.usage.observed",
      "data": { "$ref": "#/schemas/CodexUsage" }
    }
  }
}
```

The event envelope may add identity, causation, partition, and time metadata.
Those fields describe occurrences. The referenced schema describes `data`.

## Sources introduce Observables

A source is anything equivalent to constructing a new Observable. Sources have
two categories.

### External dispatch union

External dispatch is the union of every input occurrence the host may deliver.
OpenAPI's dispatch domain is the set of declared `(path, method)` pairs:

```text
(/users/{id}, GET)
(/users, POST)
(/jobs/{id}, DELETE)
```

JSON-Rx's dispatch domain is the set of declared external source discriminants.
The exact key can be a source name or a structured protocol-specific address:

```text
(panel.visibility)
(codex.appServer, account/rateLimits/updated)
(browser.network, GET, /api/organizations/{id}/usage)
(filesystem, changed, /claimed/root)
```

Its type is a discriminated union:

```ts
type ExternalInput =
  | { source: "panel.visibility"; event: PanelVisibility }
  | { source: "codex.rateLimits.updated"; event: CodexRateLimitsUpdated }
  | { source: "browser.network.response"; event: NetworkResponse }
  | { source: "filesystem.changed"; event: FilesystemChanged };
```

Host dispatch performs one operation:

```text
external occurrence
  -> resolve source discriminant
  -> validate event against its declared schema
  -> next(event) on that source instance
```

Flows subscribe to source references. Dispatch does not need to know which
flows consume the source, and the document does not need a separate connection
graph. One source may feed zero, one, or several named flows through ordinary
Observable subscription and sharing semantics.

Protocol bindings can define structured discriminants without changing the
core source contract. Browser network dispatch may match method plus URL
pattern, filesystem dispatch may match claim plus event kind, and app-server
dispatch may match JSON-RPC method. These are the temporal equivalents of
OpenAPI path/method matching.

### Portable constructors

The runtime can construct these without an external host capability:

```json
{
  "timer": {
    "dueMs": 0,
    "periodMs": 5000
  }
}
```

Examples include `of`, `from` over JSON arrays, `empty`, `never`, `throw`,
`defer`, and logical timers when the runtime has a clock.

### Host sources

The host provides these from an external system:

```json
{
  "sources": {
    "panel.visibility": {
      "event": { "$ref": "#/events/PanelVisibility" },
      "host": "instant.panelVisibility"
    },
    "codex.rateLimits.updated": {
      "event": { "$ref": "#/events/CodexRateLimitsUpdated" },
      "host": "codex.appServer.rateLimitsUpdated"
    }
  }
}
```

The same source declaration can lower differently:

| Source | Browser/TypeScript host | Rust host | Durable host |
| --- | --- | --- | --- |
| panel visibility | `IntersectionObserver` plus `visibilitychange` | host UI event stream | unavailable |
| interval | RxJS `timer` | `tokio::time::interval` wrapped as `Stream` | cron or persisted scheduler |
| filesystem | Tauri event Observable | `notify` plus channel stream | watcher service |
| HTTP response | page interceptor | HTTP body stream | gateway or message channel |
| shell process | Node child-process events | process stdout/stderr streams | remote executor events |

Source definitions describe the event shape and capability name. Credentials,
file descriptors, tab IDs, process handles, and wake mechanisms remain host
state.

## Flows are named Observable expressions

A flow is analogous to assigning an Observable expression to a variable:

```ts
const codexUsage$ = visibility$.pipe(
  distinctUntilChanged(),
  switchMap(whileVisible),
  shareReplay({ bufferSize: 1, refCount: true }),
);
```

Illustrative JSON:

```json
{
  "flows": {
    "codex.usage": {
      "output": { "$ref": "#/events/CodexUsageObserved" },
      "pipe": [
        { "source": "panel.visibility" },
        { "distinctUntilChanged": {} },
        {
          "switchMap": {
            "flow": "codex.usage.whileVisible"
          }
        },
        {
          "shareReplay": {
            "bufferSize": 1,
            "refCount": true
          }
        }
      ]
    }
  }
}
```

The JSON representation still needs a precise rule for inline inner flows,
operator arguments, and input binding. The semantic requirement is already
clear: each pipe element consumes the Observable produced immediately before
it and produces the Observable consumed immediately after it.

## Higher-order and monadic temporal composition

Mapping a value to an inner Observable introduces another timeline. Flattening
chooses how the inner instances coexist:

| Operator | Existing inner instance when a new outer value arrives |
| --- | --- |
| `switchMap` | unsubscribe it and subscribe to the new inner Observable |
| `concatMap` | queue the new inner Observable until prior work completes |
| `mergeMap` | subscribe concurrently, optionally with a bound |
| `exhaustMap` | retain the active inner Observable and ignore the new one |

This is the inter-instance temporal layer that a statechart transition table
does not directly express.

```text
outer occurrence
  -> function producing inner Observable
  -> flattening policy
  -> one output Observable
```

Visibility-controlled work is one example:

```ts
const visibleUsage$ = visibility$.pipe(
  distinctUntilChanged(),
  switchMap((visible) => {
    if (!visible) return NEVER;

    return merge(
      of("immediate"),
      timer(5000, 5000),
    ).pipe(
      exhaustMap(readRateLimits),
      map(normalizeUsage),
    );
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);
```

The placement of `exhaustMap` inside the visible branch gives snapshot reads
the same subscription lifetime as the timer. Hiding the panel disposes the
whole inner routine.

## Recurrence, scan, and machines

Pure FRP describes a value through the set of temporal inputs that determine
its next value. Runtime memory appears when the calculation depends on prior
history. `scan` expresses that recurrence:

```text
output(0) = initial
output(t + 1) = reducer(output(t), input(t + 1))
```

A reducer machine lowers directly to `scan`:

```ts
const state$ = events$.pipe(
  scan(transition, initial),
);
```

A `Subject` is only needed for an imperative mailbox. Inputs composed from
timers, browser events, network responses, and other flows require no subject.

Statechart syntax can remain a reusable authoring vocabulary:

```text
statechart definition
  -> event normalization
  -> transition reducer
  -> scan
  -> value flow
```

Full SCXML behavior adds event queues, hierarchy, parallel regions, transition
priority, entry and exit ordering, and invoked-child cancellation. A statechart
lowering must implement those semantics around its recurrence. The resulting
runtime value remains an Observable.

Multiple instances are ordinary keyed higher-order flows:

```ts
events$.pipe(
  groupBy(partitionKey),
  mergeMap((partition$) =>
    partition$.pipe(scan(transition, initial)),
  ),
);
```

## Observable and subscription lifecycle

The ReactiveX value protocol is:

```text
next* (error | complete)?
```

One subscription adds acquisition and disposal:

```text
subscribe
  -> next*
  -> error | complete | unsubscribe
  -> finalize
```

Every named flow and selected operator boundary should be tappable for
diagnostics:

```ts
type LifecycleTap<T> = {
  subscribe?: () => void;
  next?: (value: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
  finalize?: () => void;
};
```

RxJS `tap` covers value-channel notifications. `finalize` covers termination
and explicit unsubscription. Runtime instrumentation is also required for
operator-local outcomes that do not reach the output, such as:

- `filter` rejected a value
- `throttle` or `debounce` replaced a pending value
- `exhaustMap` ignored an outer value
- `switchMap` cancelled an inner subscription
- a bounded buffer dropped or rejected a value

These diagnostics belong on a separate trace stream. They must not alter the
observed flow.

## Hot, cold, shared, and replayed

| Form | Subscription behavior |
| --- | --- |
| cold flow | each subscriber creates independent source and operator instances |
| hot source | production exists independently of a particular subscriber |
| `share` | subscribers share one upstream subscription while sharing policy permits |
| `shareReplay` | shared upstream plus bounded replay to later subscribers |
| subject | imperative observer/Observable bridge supplied by some hosts |

Sharing is an operator-level semantic. “Latest value” comes from replay with a
buffer size of one. It does not require another retain or cache primitive.

`refCount` controls demand by subscriber count at the subscription level:

```text
first downstream subscriber
  -> subscribe upstream

last downstream subscriber leaves
  -> unsubscribe upstream
```

This supplies the basic “poll only while the dashboard is observed” behavior.
Panel visibility can further switch the active inner routine while preserving
the outer shared latest value.

## Scheduler and demand are separate axes

A scheduler controls when and where work executes:

```text
current call stack
microtask queue
animation frame
timer clock
thread pool
executor
test virtual time
```

Demand controls whether and how much upstream may produce:

```text
subscriber ready for N values
consumer polls for one next value
queue has capacity K
downstream pauses or cancels
```

A different RxJS scheduler can move notification and subscription work through
time or across execution contexts. It does not add a `request(n)` protocol,
make a hot DOM source pausable, or bound an intervening queue.

The relevant runtime models are:

| Runtime model | Direction of control | Native pressure behavior |
| --- | --- | --- |
| RxJS Observable | producer pushes notifications after subscription | cancellation and explicit buffering/drop operators; no general `request(n)` |
| Reactive Streams | publisher pushes at most the outstanding requested demand | mandatory asynchronous `request(n)` and cancellation |
| Rust `Stream` | consumer calls `poll_next`; producer registers a wakeup when pending | downstream pull/readiness at each item boundary |
| async iterator | consumer awaits `next()` | one pull per awaited item unless adapters prefetch |
| channel stream | producer sends through a queue, consumer receives | pressure depends on bounded versus unbounded channel |

JSON-Rx should specify logical operator behavior independently from one runtime
mechanism, then require a host pressure profile at boundaries where behavior
can diverge.

```ts
type PressureProfile =
  | { model: "push" }
  | { model: "request"; maxInFlight: number }
  | { model: "poll" }
  | {
      model: "buffered";
      capacity: number;
      overflow: "block" | "drop-oldest" | "drop-latest" | "latest" | "error";
    };
```

This shape is provisional. The specification work is to determine which
pressure semantics belong to sources, async boundaries, flattening operators,
and host profiles without adding policy fields to unrelated operators.

## Channels, MPSC, and Observable boundaries

Go channels, Rust MPSC channels, and Reactive Streams subscriptions expose
delivery contracts around a temporal value sequence. They can back JSON-Rx
sources without replacing the flow algebra.

```text
producer A ─┐
producer B ─┼─ bounded MPSC queue ─ receiver ─ Observable/Stream source
producer C ─┘
```

The host binding needs to preserve facts that affect behavior:

| Channel fact | Observable consequence |
| --- | --- |
| producer cardinality | one producer or merged concurrent producers |
| receiver cardinality | unicast receiver or host multicast adapter |
| capacity | maximum queued values before pressure or overflow |
| send behavior | await/block, reject, drop, replace latest, or error |
| receive behavior | callback push, `recv().await`, or `poll_next` |
| ordering | FIFO globally, FIFO per producer, or host-defined |
| closure | source completes after all senders close and the queue drains |
| sender failure | error value, error notification, or host diagnostic |
| cancellation | receiver drop, explicit cancel, or detached producer |

Conceptual source declaration:

```json
{
  "sources": {
    "codex.protocol.events": {
      "event": { "$ref": "#/events/CodexProtocolEvent" },
      "host": "codex.appServer.events",
      "delivery": {
        "producers": "many",
        "receivers": "one",
        "capacity": 128,
        "ordering": "fifo",
        "overflow": "block"
      }
    }
  }
}
```

`delivery` belongs to a host or source-binding vocabulary because RxJS itself
does not enforce this contract. A Go host can lower it to a buffered channel. A
Rust host can lower it to bounded `mpsc`. A Java host can lower it to a
Reactive Streams publisher. A browser host may reject `overflow: block` for a
DOM event source that cannot be paused and require `drop`, `latest`, or a
bounded buffer instead.

After the boundary, ordinary Rx operators compose the stream:

```text
channel-backed source
  -> map
  -> groupBy
  -> mergeMap
  -> scan
  -> share
```

Channel capacity and send pressure remain properties of the boundary.
Flattening concurrency, buffering operators, sharing, and cancellation remain
properties of the flow stages where they occur.

## Rust lowering

The Rust reference target should use `futures_core::Stream` and extension
operators rather than an all-push Rx port.

```text
JSON-Rx source
  -> host Stream<Item = Event>
  -> StreamExt combinators
  -> Pin + poll_next + Waker
  -> downstream consumer
```

Conceptual lowering table:

| JSON-Rx / Rx operator | Rust stream construction |
| --- | --- |
| `map` | `StreamExt::map` |
| `filter` | `StreamExt::filter` or `filter_map` |
| `scan` | `StreamExt::scan` |
| `merge` | `select`, `select_all`, or a fairness-aware custom combinator |
| `concatMap` | map to streams, then ordered flatten |
| `mergeMap` | `buffer_unordered`-style concurrent inner futures/streams |
| `switchMap` | custom current-inner stream with replacement and cancellation |
| `exhaustMap` | custom active-inner gate |
| `takeUntil` | select source against termination stream |
| `share` | host multicast task plus subscriber channels |
| `shareReplay(1)` | shared task plus bounded latest-value cell/channel |

Exact lowering depends on whether the inner value is a `Future`, a `Stream`,
or either. Fairness, fused termination, cancellation safety, and pinning need
conformance fixtures rather than assumed equivalence from operator names.

## Time domains

JSON-Rx must distinguish time carried by data from time used to execute work:

| Time | Meaning |
| --- | --- |
| event time | when the represented occurrence happened |
| processing time | when a host processed the occurrence |
| scheduler time | the clock controlling timer and delay operators |
| subscription time | when a flow instance acquired its sources |
| logical time | ordering/version domain supplied by a dataflow host |

RxJS timers usually use scheduler time. Browser captures carry event and
processing timestamps. Beam contributes window, watermark, and late-data
semantics if JSON-Rx later needs event-time aggregation. Timely and
Differential Dataflow contribute logical progress and update-difference
semantics for incrementally maintained collections.

## Host operations and streaming effects

An external operation that returns one or more asynchronous values is naturally
an Observable-producing function:

```ts
type HostOperation = (
  input: JsonValue,
  context: HostContext,
) => Observable<JsonValue>;
```

Flattening operators compose operation instances. This covers:

- one-response HTTP calls
- WebSocket and LSP sessions
- shell processes with stdout, stderr, exit, and failure events
- browser actions followed by lifecycle notifications
- Codex app-server snapshots and update notifications

The shell example is duplex:

```text
invocation and stdin flow
  -> host process operation
  -> started | stdout | stderr | exited | failed flow
```

The host defines quoting, template validation, credentials, framing, queue
bounds, termination, and transport. JSON-Rx composes the resulting flow.

## Application subscription boundary

JSON-Rx defines named Observables. It does not need to encode every application
consumer as a sink or connection.

```ts
const flow$ = runtime.flow("codex.usage");
const subscription = flow$.subscribe(renderOrPersist);
```

The host knows why it requested the flow and owns that subscription. A future
deployment vocabulary may declare exported roots or startup subscriptions, but
that concern should remain outside the core operator algebra until a concrete
host needs portable startup wiring.

## Specification, implementation claims, and generation

A JSON-Rx document describes an Observable circuit independently from the code
that realizes it. A host may consume the document in three modes:

| Mode | Input | Result |
| --- | --- | --- |
| interpret | JSON-Rx document plus host capability bindings | executable flow graph |
| generate | JSON-Rx document plus a target profile | TypeScript, Rust, Go, or other scaffold |
| verify | JSON-Rx document plus implementation claims and code evidence | conformance report |

An implementation claim binds a specification node to existing code:

```json
{
  "implements": {
    "flows.codex.usage": {
      "target": "typescript",
      "module": "src/codex/usage.ts",
      "export": "codexUsage$",
      "profile": "rxjs-7"
    }
  }
}
```

Verification has two layers:

1. Structural verification resolves symbols, schemas, operator support, source
   capabilities, pressure profiles, and generated type compatibility.
2. Behavioral verification runs shared virtual-time fixtures and compares
   values, timing, subscriptions, cancellation, termination, sharing, replay,
   ordering, and pressure traces.

Static inspection can prove that an exported symbol and required operator
bindings exist. Behavioral conformance requires execution because arbitrary
host code can satisfy the same type while violating temporal semantics.
Generated scaffolds should contain stable node identifiers so later checks can
map source spans and diagnostics back to specification nodes.

```text
JSON-Rx circuit
  ├─ interpret directly
  ├─ generate target scaffold ─ edit implementation ─ verify
  └─ bind existing code ───────────────────────────── verify
```

This resembles AsyncAPI's document and code-generation relationship, applied
to the temporal circuit inside a process. Broker, protocol, and deployment
descriptions remain optional host bindings.

## Minimal calculus and derived operators

The specification should separate a small semantic kernel from the RxJS-shaped
authoring vocabulary. Authors use familiar operators. A compiler lowers those
operators into the kernel for validation, interpretation, generation, and
cross-runtime tests.

Provisional kernel:

| Form | Role |
| --- | --- |
| `source(ref)` | introduce an external or constructed notification sequence |
| `map(f, x)` | transform each next value while preserving lifecycle |
| `filter(p, x)` | conditionally preserve next values |
| `scan(step, seed, x)` | causal recurrence over prior accumulation and current input |
| `merge(xs)` | interleave notifications from concurrent inputs |
| `concat(xs)` | subscribe to inputs sequentially after completion |
| `flatten(policy, x)` | subscribe to a stream of streams with concurrency and cancellation policy |
| `catch(handler, x)` | replace an errored input with another sequence |
| `takeUntil(stop, x)` | terminate an input from another sequence |
| `share(policy, x)` | control source-subscription sharing and optional replay |

`flatten` carries the semantic difference among the RxJS flattening family:

```ts
type FlattenPolicy =
  | { kind: "merge"; concurrency?: number }
  | { kind: "concat" }
  | { kind: "switch" }
  | { kind: "exhaust" };
```

Derived examples:

```text
mergeMap(f)   = map(f) |> flatten({ kind: "merge" })
concatMap(f)  = map(f) |> flatten({ kind: "concat" })
switchMap(f)  = map(f) |> flatten({ kind: "switch" })
exhaustMap(f) = map(f) |> flatten({ kind: "exhaust" })

withLatestFrom(a, b)
  = sample latest(b) whenever a emits

debounceTime(t)
  = switchMap(x => timer(t).pipe(map(() => x)))
```

The kernel is provisional until each desired RxJS operator has either a
semantics-preserving lowering or evidence that another primitive is required.
The completeness test is the operator and host-capability matrix, followed by
shared timeline fixtures. Minimality is tested by removing one primitive and
checking whether its behavior can still be derived without smuggling that
behavior into host code.

Backpressure remains a boundary and execution-profile dimension. Adding
`request(n)`, bounded send, or `poll_next` to the kernel would couple every
logical flow to one runtime protocol. Pressure-aware sources and async
boundaries expose those contracts through host profiles and conformance traces.

## Process-local circuit boundary

The primary JSON-Rx subject is the temporal circuit inside one application
process:

```text
external inputs
  ~> source adapters
  -> map/filter/combine/flatten/scan
  ~> host effects
  -> effect result streams
  -> shared derived flows
  -> application subscribers
```

This circuit exists even when every value is ephemeral and a process restart
may discard all active subscriptions and accumulations. The specification makes
that wiring inspectable, testable, generatable, and comparable across language
runtimes.

Cross-process durability adds another execution contract around the circuit:

```text
process-local circuit
  -> command history
  -> durable coordinator
  -> worker routing and retries
  -> deterministic replay after failure
```

Temporal's Workflow model records commands and events in a durable history,
re-executes deterministic Workflow code against that history, and places
non-deterministic I/O in Activities. Those semantics apply when an execution
must survive process and infrastructure failure. They are optional for an
in-process JSON-Rx graph whose lifetime is one application instance.

| Concern | JSON-Rx core | Optional durable workflow profile |
| --- | --- | --- |
| internal event circuit | specified | consumes the same circuit model |
| Observable lifecycle | specified | history may outlive a subscription/process |
| operator cancellation | specified | durable command cancellation adds coordination |
| timers | scheduler-time semantics | timers recorded by durable service/history |
| effects | host Observable-producing operation | replay-safe Activity boundary |
| recurrence | `scan` over received values | state rebuilt by deterministic history replay |
| crash recovery | host-defined | required |
| worker routing | outside core | required |
| durable retries | optional host operation policy | first-class execution policy |
| versioning/patching | specification evolution | deterministic replay compatibility |

Temporal therefore contributes a deployment and durability profile, plus a
conformance question: can a JSON-Rx flow be lowered into deterministic workflow
code with every non-deterministic source or effect externalized? Flows that use
only replay-safe operators, injected clocks, recorded inputs, and declared host
effects can support that profile. Ordinary UI and local-tool flows need no
history service.

## Durable logs without a broker requirement

Kafka contributes a durable temporal boundary model that can be implemented by
a single local process:

| Kafka concept | Portable semantic fact | Single-binary realization |
| --- | --- | --- |
| topic | named durable event sequence | named file or SQLite table |
| partition | ordered shard and parallelism unit | shard key plus per-shard sequence |
| offset | consumer-controlled position | integer cursor/checkpoint |
| retention | replay horizon independent of current consumers | age/size cleanup policy |
| consumer group | one logical subscriber with partition work sharing | local worker identity and leases |
| replay | seek to an earlier position and consume again | cursor reset and sequential read |
| producer batching | bounded latency/size accumulation before append | in-process batch writer |
| idempotent production | retry without duplicate append within its guarantee scope | producer id plus sequence/dedup key |
| transaction | atomic output records plus consumed-position update | one SQLite transaction or log protocol |

Kafka ordering is per partition. A keyed local log can preserve the same fact
without brokers, replication, JVM processes, or network protocols. Consumer
fetch is pull-shaped: a consumer requests records beginning at an offset and
controls when that offset is committed. That maps directly to a durable source
adapter feeding an Observable or Rust `Stream`.

```text
host event
  -> append(key, envelope)
  -> durable ordered record(position)
  -> read(from position, batch limit)
  -> JSON-Rx source
  -> ordinary Rx flow
  -> checkpoint(position)
```

Durability, partitioning, cursor commits, deduplication, and transaction scope
belong to the source/effect binding. They should not alter `map`, `filter`,
`scan`, or flattening semantics. An in-memory channel profile and a durable-log
profile can therefore expose the same named source with different restart,
replay, and delivery guarantees.

## Inspiration matrix

| System or specification | Reused concept | Deliberately outside its contribution |
| --- | --- | --- |
| [Functional Reactive Animation](https://users.cs.northwestern.edu/~robby/courses/395-495-2009-winter/fran.pdf) | behaviors as time-varying values and events as occurrences | concrete distributed execution and JSON interchange |
| [ReactiveX Observable contract](https://reactivex.io/documentation/contract.html) | `next/error/complete`, subscription, unsubscription, optional request semantics | one mandatory cross-language pressure model |
| [ReactiveX operators](https://reactivex.io/documentation/operators.html) | ordered operator chains, constructors, combination, flattening, error and utility operators | identical operator availability in every host |
| [ReactiveX scheduler model](https://reactivex.io/documentation/scheduler.html) | execution-time and notification-context control | demand and bounded-queue semantics |
| [RxJS `shareReplay`](https://rxjs.dev/api/index/function/shareReplay) | shared source subscription and bounded replay | generic persistence or materialized database views |
| [Reactive Streams](https://github.com/reactive-streams/reactive-streams-jvm) | demand, cancellation, serial signaling, bounded asynchronous boundaries | transformation operator vocabulary |
| [Rust `Stream`](https://docs.rs/futures/latest/futures/stream/trait.Stream.html) | `poll_next`, readiness, wakeups, consumer-driven progress | automatic multicast or replay |
| [W3C SCXML](https://www.w3.org/TR/scxml/) | event queues, guards, hierarchy, invoked-child identity and cancellation | general higher-order Observable composition |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-core) | shared JSON types, references, dialects, annotations, extension vocabularies | temporal execution semantics |
| [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) | self-contained document, reusable components, schemas, named external operations | long-lived arbitrary temporal graphs |
| [AsyncAPI 3.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0) | message schemas, channels, operations, protocol-specific host bindings | in-process operator graph and flattening semantics |
| [Smithy waiters](https://smithy.io/2.0/additional-specs/waiters.html) | serialized polling delay, matching, retry, success and failure | general FRP composition and sharing |
| [Apache Beam](https://beam.apache.org/documentation/basics/) | event time, processing time, windows, triggers, watermarks, late data | UI-scale Observable subscription semantics |
| [Differential Dataflow](https://timelydataflow.github.io/differential-dataflow/) | incrementally maintained outputs, logical time, shared indexed arrangements | Rx lifecycle and host effect invocation |
| [Kubernetes list/watch](https://kubernetes.io/docs/reference/using-api/api-concepts) | initial snapshot plus versioned update stream and reconciliation | generic operator language |
| [Apache Kafka design](https://kafka.apache.org/41/design/design/) | partitioned append-only logs, offsets, pull fetches, replay, batching, idempotent production, and atomic output-plus-offset updates | broker cluster, JVM runtime, replication topology, and protocol administration |
| [Temporal Workflows](https://docs.temporal.io/workflows) | command/event history, deterministic replay, durable timers, execution identity, and effect isolation through Activities | mandatory durability for ordinary process-local reactive wiring |

## Capability comparison

| Capability | RxJS | Reactive Streams | Rust Stream | SCXML | Beam | JSON-Rx target |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| named reusable flows | code variables | publisher values | stream values | invoked services | transforms | yes, serialized |
| map/filter/scan | yes | implementation-specific | yes | executable content | yes | yes |
| higher-order flattening | yes | implementation-specific | extension/custom | invoked children | composite transforms | yes |
| terminal error channel | yes | yes | usually `Item = Result` | error events | runner errors | declared profile |
| cancellation | unsubscribe | cancel | drop / cancellation-safe poll | exit invoking state | runner-dependent | required |
| multicast/replay | operators/subjects | implementation-specific | host task/channels | event broadcast rules | shared runner graph | operators |
| demand protocol | no general protocol | `request(n)` | `poll_next` | no element demand | runner-managed | host profile |
| event-time windows | operator libraries | outside core | custom | timers/events | first class | later vocabulary |
| statechart hierarchy | custom | outside core | custom | first class | outside core | lowering vocabulary |
| JSON schemas | TypeScript/runtime | outside core | Rust types | data model-specific | coder/schema systems | JSON Schema |
| portable JSON program | no | protocol only | no | XML document | pipeline APIs/YAML | yes |

## Semantic core and host variation

The portable core should fix:

1. Observable notification grammar.
2. Pipe ordering and operator argument binding.
3. Source, flow, and schema reference resolution.
4. Higher-order subscription and cancellation semantics.
5. Error and completion behavior.
6. Sharing and replay behavior.
7. Logical timer behavior under an injected clock.
8. Diagnostic lifecycle events.

Host profiles should declare:

1. Available source and operation capabilities.
2. Push, request-count, poll, or buffered pressure behavior.
3. Scheduler and clock implementation.
4. Queue bounds and overflow where asynchronous boundaries exist.
5. Cancellation guarantees.
6. Threading, fairness, and ordering guarantees beyond the portable minimum.
7. Persistence, credentials, and resource ownership.

## Conformance strategy

The TypeScript and Rust implementations should run shared JSON fixtures. A
fixture supplies input timelines, subscription actions, virtual time, and
expected output plus lifecycle traces.

```json
{
  "flow": "example.switch",
  "inputs": {
    "outer": [
      { "at": 0, "next": "a" },
      { "at": 5, "next": "b" },
      { "at": 20, "complete": true }
    ]
  },
  "subscriptions": [
    { "at": 0, "subscribe": "observer-1" },
    { "at": 12, "unsubscribe": "observer-1" }
  ],
  "expect": {
    "values": [],
    "lifecycle": []
  }
}
```

Conformance dimensions:

| Dimension | Assertion |
| --- | --- |
| values | same values in the same logical order |
| time | same virtual timestamps where timing is normative |
| termination | same error or completion behavior |
| subscription | same source acquisition and release timeline |
| cancellation | same inner work disposed by flattening operators |
| sharing | same upstream subscription count |
| replay | same values delivered to late subscribers |
| pressure | behavior matches the declared host profile |
| diagnostics | same portable lifecycle and drop reasons |

## Initial scope

The first specification slice should contain:

- JSON Schema references
- event definitions
- portable constructors: `of`, `from`, `empty`, `never`, `throw`, `defer`,
  `timer`
- host source references
- named flows
- `map`, `filter`, `scan`
- `merge`, `concat`, `combineLatest`, `withLatestFrom`
- `switchMap`, `concatMap`, `mergeMap`, `exhaustMap`
- `distinctUntilChanged`, `takeUntil`, `catchError`, `retry`
- `share`, `shareReplay`
- `tap`, `finalize`, and diagnostic traces
- virtual-time conformance fixtures

Backpressure should enter through a documented host-profile and boundary model
before adding pressure-specific operators. Statecharts, Beam-style event-time
windows, differential collections, startup roots, and deployment wiring can
follow as vocabularies once a concrete Instant automation requires them.

## Consequences for Instant

The Codex usage tracker becomes a named flow:

```text
panel visibility
  -> switchMap visible routine
       -> merge immediate tick, interval ticks, app-server updates
       -> exhaustMap snapshot reads
       -> scan sparse updates into complete snapshots
       -> map normalized usage
  -> shareReplay(1, refCount)
```

Instant subscribes while rendering or persisting the flow. Two dashboard views
can subscribe to `claude.usage` and `codex.usage` side by side. Sharing prevents
duplicate upstream work. Visibility switches the polling routine. The host
adapter owns the Codex process and protocol. The Metrics plugin remains a
consumer of `stream + schema + timestamped records + provenance`.
