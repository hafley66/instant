# Sprefa as a relational reactive runtime

## Purpose

Sprefa and JSON-Rx describe two temporal views of a program.

Sprefa evaluates relations to a least fixpoint inside a tick:

```text
external world
  -> source relations
  -> least fixpoint
  -> sink relations
  -> effects
  -> next-tick source updates
```

JSON-Rx evaluates notification sequences through an Observable graph:

```text
external world
  -> source Observables
  -> operator graph
  -> effect operations
  -> effect-result Observables
  -> continued graph
```

Sprefa supplies relational collection semantics and stabilization. JSON-Rx
supplies sequence semantics, subscription lifecycles, higher-order asynchronous
composition, and cancellation.

## Direct correspondences

| Sprefa | JSON-Rx / Rx |
| --- | --- |
| relation declaration | named typed flow or materialized collection |
| source relation | host Observable source |
| rule body | point-free operator composition |
| rule head | projected output flow |
| recursive rule | `scan`, `expand`, or feedback |
| stratification | dependency and evaluation-order validation |
| least fixpoint | convergence of recurrent derivation |
| tick | transaction, frame, or stabilization boundary |
| `@next` | one-tick delay or register |
| `clock` | time source carrying a monotonic bucket |
| `every` | periodic trigger source |
| `@async` | `mergeMap`-shaped effect invocation |
| `@stream` | effect returning an Observable |
| demand relation | effect-request stream |
| `effect_log` | materialized operation lifecycle trace |
| sink relation | host subscriber or operation invocation |
| relation contents | latest materialized collection |
| changed source facts | input delta |
| converged tick | quiescent graph |

The simplest rule correspondence is:

```dl
output(Y) <- input(X), transform(X, Y).
```

```ts
const output$ = input$.pipe(
  map(transform),
);
```

The Datalog rule describes a relation. The Rx expression describes an
occurrence sequence. Their similar dataflow shape operates over different base
objects.

## Relations over time

Sprefa operates on the current extension of each relation:

```text
Relation<Row> at tick N
```

Rx ordinarily operates on occurrences:

```text
Notification<Row> occurring at time N
```

A relation-valued Observable bridges the models:

```ts
type Relation<Row> = ReadonlySet<Row>;

type RelationFlow<Row> = Observable<Relation<Row>>;
```

An incremental bridge carries differences:

```ts
type Difference<Row> = {
  row: Row;
  weight: number;
};

type DifferentialFlow<Row> = Observable<Difference<Row>>;
```

Sprefa's tick can be described as an Rx recurrence over buffered source deltas:

```ts
sourceDeltas$.pipe(
  bufferByTick(),
  scan(applySourceDeltasAndReachFixpoint, initialDatabase),
  map(runSinks),
);
```

This pseudocode names the temporal boundary. Sprefa's actual implementation
uses source refresh, relational derivation, fixpoint convergence, and sink
draining.

## Joins and combination

A Datalog join operates over materialized relation contents:

```dl
joined(A, B, C) <-
  left(A, B),
  right(B, C).
```

Its Rx analogue combines the latest complete relations and performs a
relational join:

```ts
const joined$ = combineLatest([leftRelation$, rightRelation$]).pipe(
  map(([left, right]) => relationalJoin(left, right)),
  distinctUntilChanged(relationEqual),
);
```

`merge(left$, right$)` would interleave occurrences. It would not perform the
relational join represented by the Datalog body.

## `@next` as a register

Sprefa's `@next` carries a value from one tick into the next:

```text
current tick output
  -> register
  -> next tick input
```

Mathematically:

```text
next(x)[t] = x[t - 1]
```

This makes a cyclic dependency causal:

```text
A[t] -> B[t]
B[t] -> A[t + 1]
```

The same rule appears in synchronous dataflow and FRP feedback. A feedback
cycle requires an initial value, a delay, or another temporal boundary.

An approximate Rx expression is:

```ts
const prior$ = current$.pipe(
  pairwise(),
  map(([prior]) => prior),
);
```

A tick scheduler can represent it directly:

```ts
const nextTick$ = current$.pipe(
  delay(1, tickScheduler),
);
```

## Clocks and periodic triggers

Sprefa has two related clock relations:

```text
clock(N, bucket)
  current monotonic bucket for period N

every(N)
  present on ticks crossing an N-second boundary
```

Their Rx shapes are:

```ts
const clock$ = timer(0, period).pipe(
  map(() => currentBucket(period)),
);

const every$ = timer(0, period);
```

`clock` carries a value used in derivation and digest variation. `every` acts
as an edge-like trigger. JSON-Rx should preserve that distinction between a
time-varying value and an occurrence stream.

## `@async` and flattening

Sprefa derives effect-request rows and drains all distinct requests that become
eligible during a tick. This resembles unbounded `mergeMap`:

```ts
requests$.pipe(
  mergeMap(runEffect),
);
```

The Rx flattening family names alternative admission and ownership policies:

| Policy | Rx operator shape |
| --- | --- |
| launch all eligible requests | `mergeMap(effect, Infinity)` |
| at most N active requests | `mergeMap(effect, N)` |
| queue requests and run one at a time | `concatMap(effect)` |
| replace prior work with the latest request | `switchMap(effect)` |
| ignore requests while one is active | `exhaustMap(effect)` |

Sprefa's set semantics and content-addressed request IDs add deduplication.
Ordinary Rx sequences preserve duplicate occurrences unless a deduplication
operator or keyed instance registry removes them.

## Content-addressed effect identity

The Sprefa effect queue identifies work using the effect head, kind, and bound
arguments. That supports stable deduplication across ticks.

The documented template-edit behavior reveals a missing identity dimension:

```text
effect identity
  = operation definition
  + bound arguments
  + relevant implementation digest
```

If the implementation digest is absent, changing a shell template leaves the
request identity unchanged and completed work remains considered current.

JSON-Rx can represent the same identity with a canonical operation-instance
URL:

```text
jsonrx://sprefa/effects/npm/{package}?version={version}&implementation={digest}
```

Filled example:

```text
jsonrx://sprefa/effects/npm/rxjs?implementation=sha256%3Aabc&version=7.8.2
```

## `@stream` as an Observable-producing operation

Sprefa's `@stream` matches the JSON-Rx host-operation signature:

```ts
type HostOperation<Input, Output> =
  (input: Input) => Observable<Output>;
```

The npm dependency crawler has this temporal shape:

```text
seed package
  -> stream dependency results
  -> derive unseen package coordinates
  -> invoke more streams
  -> accumulate graph relation
  -> converge when no unseen coordinates remain
```

An Rx expansion can describe the occurrence side:

```ts
seed$.pipe(
  expand(fetchDependencies),
  scan(addPackageToGraph, emptyGraph),
);
```

Sprefa's recursive relations describe the expansion and use set semantics to
suppress previously known coordinates. The fixpoint supplies a precise
completion condition for each stabilized tick.

## Demand relations as effect request streams

Sprefa relations such as `checkout`, `rev_cmp_want`, and `scip_want` are
declarative requests. Their corresponding result relations appear on a later
tick.

```text
demand relation row
  -> host effect
  -> result relation row
  -> next evaluation tick
```

In JSON-Rx terms:

```text
request flow
  -> operation invocation
  -> result flow
  -> downstream recurrence
```

The Datalog program writes desired work as data. The runtime interprets that
data as effects. This is equivalent to a serialized effect algebra whose
requests happen to use relation rows as the instruction format.

## Coordinates and instance URLs

Sprefa's core coordinate is:

```text
(repo, path, rev)
```

JSON-Rx uses a URI template plus filled path and query parameters. The Sprefa
coordinate maps directly:

```text
jsonrx://sprefa/source/file/{repo}/{rev}/{path}
```

Filled example:

```text
jsonrx://sprefa/source/file/instant/WORK/src/main.ts
```

Additional runtime coordinates can use the same hierarchy:

```text
jsonrx://sprefa/programs/npm-crawl/ticks/42
jsonrx://sprefa/programs/npm-crawl/relations/dependency?tick=42
jsonrx://sprefa/programs/npm-crawl/effects/npm/rxjs?version=7.8.2
```

Canonical coordinates support:

- cache keys
- source identity
- effect deduplication
- diagnostics
- lifecycle traces
- materialized result lookup
- incremental invalidation

## Notification identity under set semantics

Datalog relations use set semantics. Rx sequences retain repeated equal values:

```text
next(5)
next(5)
```

A relation would collapse those occurrences unless notification identity is
part of the row:

```text
notification(instance, subscription, sequence, kind, value)
```

A relational encoding of the Observable protocol therefore requires at least:

```text
instance URL
subscription identity
monotonic sequence or logical-time coordinate
notification kind
payload or error
```

Terminal constraints can then be checked relationally:

```text
at most one terminal notification per subscription
no notification after terminal sequence
error and complete are mutually exclusive terminals
```

## Semantic differences

| Property | Sprefa | Rx |
| --- | --- | --- |
| basic value | relation row | notification payload |
| collection semantics | set | sequence |
| duplicates | removed by relational identity | retained |
| ordering | absent unless encoded | observable and operator-dependent |
| stabilization | least fixpoint per tick | notifications continue until termination |
| recurrence | recursive rules and prior tick | `scan`, feedback, and higher-order operators |
| effects | demand rows drained after derivation | Observable-producing operations |
| cancellation | effect-runtime policy | subscription lifecycle |
| backpressure | tick, drain, and budget boundaries | source and operator admission |
| latest state | relation extension | replayed or scanned value |
| deletion | source retraction and derived rebuild | removal event or collection difference |

Two consequences follow from this table.

First, lowering Rx into ordinary Datalog requires explicit identity, order, and
multiplicity columns. Second, lowering Datalog into ordinary Rx requires a
relation-valued or differential operator that performs joins, stratification,
and fixpoint convergence.

## Combined boundary

JSON-Rx can own temporal orchestration:

```text
when to subscribe
when to switch
when to cancel
when to merge
when to throttle
how to share
how protocol streams enter
```

Sprefa can own relational computation:

```text
joins
recursive closure
stratified negation
least fixpoints
incremental source maintenance
location-aware facts
materialized diagnostics
```

A minimal bridge is:

```ts
type RelationDelta<Row> = {
  relation: string;
  tick: number;
  added: Row[];
  removed: Row[];
};

type SprefaPort<Request, Row> = {
  deltas$: Observable<RelationDelta<Row>>;
  demand(request: Request): Observable<RelationDelta<Row>>;
};
```

The receive side is an Observable source. The demand side is an
Observable-producing operation. A duplex daemon or protocol connection can
host both capabilities.

## Algebraic placement

The combined system contains three calculi:

```text
CSP or channel calculus
  communication, rendezvous, buffering, endpoint direction

Rx algebra
  temporal sequence transformation and subscription ownership

relational algebra plus Datalog
  collection transformation, recursion, and fixpoint convergence
```

Their bridge types are:

```text
channel receive
  -> Observable<Notification<T>>

Observable of relation deltas
  -> tick buffer
  -> Datalog fixpoint
  -> relation deltas

derived demand rows
  -> operation invocation
  -> Observable<result>
  -> source facts for a later tick
```

Sprefa already implements the relational and ticked portions of this model in a
single local Rust binary. JSON-Rx supplies a serialized representation for the
process-local temporal circuit surrounding and connecting those evaluations.

## Implications for the JSON-Rx specification

The Sprefa comparison adds concrete requirements to JSON-Rx:

1. Collection-valued flows need declared set, bag, sequence, or differential
   semantics.
2. Feedback requires an explicit delay, initial value, or tick boundary.
3. Effect-instance identity must include operation implementation identity when
   implementation changes invalidate prior results.
4. Streaming effects are ordinary Observable-producing operations.
5. Demand relations demonstrate that effect instructions can remain data.
6. Stable coordinates should identify source, flow, operation, relation, tick,
   and subscription instances.
7. A future relational extension should lower into a dedicated fixpoint
   runtime instead of encoding joins as ad hoc Rx operators.
8. Cross-runtime conformance must include duplicate occurrences, relation
   retractions, stabilization, and effect-result latency across ticks.

The existing JSON-Rx MVP lab remains sequence-oriented. A relational extension
can be tested later through a Sprefa host binding without changing the initial
RxJS operator profile.
