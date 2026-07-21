# Changelog

## 2026-07-20

- Created the JSON-Rx automation book.
- Documented currently executable Rule JSON capture modes and scheduled tab
  reload effects.
- Documented the boundary between Rule JSON and the JSON-Rx TypeScript library.
- Specified serializable timer, delay, debounce, and throttle event sources.
- Specified reusable routine references and host-specific timer lowering.
- Specified partitioned Jenkins job aggregation, change detection, and
  materialized keyed rows.
- Recorded the proposed authenticated HTTP effect boundary.
- Defined JSON-Rx as a portable program layer with host-provided source and
  effect interpreters.
- Assigned shell, process, HTTP, WebSocket, and LSP production to Sprefa-facing
  adapters rather than Instant or the portable runtime.
- Recorded the deferred controlled shell-template contract and its dependency
  on Sprefa `sh` and `sh*` semantics.
- Defined shell execution as a host-lowered duplex JSON-Rx lifecycle stream
  with cancellation, framing, ordering, and backpressure semantics.
- Added a repository-local dashboard-builder subagent and
  `build-instant-dashboard` skill.
- Added the JSON-Rx specification synthesis covering named flows, source
  externalization, higher-order composition, recurrence, lifecycle taps,
  sharing, scheduler versus demand, Rust Stream lowering, time domains, host
  profiles, prior-art comparisons, and cross-runtime conformance.
- Added authoring directives for normalized definitions and point-free pipes,
  plus host delivery contracts for Go channels, bounded MPSC, ordering,
  closure, cancellation, and overflow behavior.
- Added the specification lifecycle for interpretation, code generation,
  existing-code implementation claims, structural checks, and behavioral
  conformance fixtures.
- Added a provisional minimal calculus with RxJS operators as derived authoring
  forms and a removal-based minimality test.
- Added Kafka's durable-log semantics as an optional single-binary host profile:
  partitions, offsets, replay, retention, batching, idempotence, and atomic
  output-plus-checkpoint updates without requiring a broker deployment.
- Defined the process-local circuit as JSON-Rx's primary boundary and compared
  it with Temporal's optional durable history, deterministic replay, Activity,
  retry, worker-routing, and crash-recovery profile.
- Added the Sprefa comparison: relation-valued flows, ticks, least fixpoints,
  `@next` delay, clocks, asynchronous and streaming effects, demand relations,
  content-addressed operation identity, stable coordinates, and the bridge
  among CSP channels, Rx sequences, and Datalog relations.
- Added the side-by-side `automation.v2` lab using Zod 4, generated Draft
  2020-12 JSON Schema, canonical IR, graph validation, a Claude v1/v2
  equivalence fixture, existing dashboard-envelope output, and overlapping
  subscriber sharing proof. Production v1 paths remain unchanged.
