# Codex host events in the isolated JSON-Rx v2 lab

This note documents the current uncommitted v2 fixture under
`labs/json-rx-mvp`. It describes the executable TypeScript lab surface. The
production extension, Rust server, app-server event bridge, database, and
Metrics panel remain outside this circuit.

## Flow shape

`11_codex-v2.fixture.ts` declares two `host.event` source bindings:

```text
jsonrx://instant/sources/codex/rate-limits-read
  operation = account/rateLimits/read

jsonrx://instant/sources/codex/rate-limits-updated
  operation = account/rateLimits/updated
```

The circuit joins those source references and applies the operators in this
order:

```text
read source  \
              -> merge -> machine(scan) -> project -> shareReplay -> dashboard root
updated source /
```

`merge` forwards whichever source event arrives. The event remains accompanied
by its source origin, consisting of `url` and `ts`.

The runtime receives already-created Observables in the `sources` argument to
`compileAutomationV2`:

```ts
compileAutomationV2(codexUsageV2, {
  [snapshotSource]: snapshots$,
  [updateSource]: updates$,
});
```

The binding operation strings are carried in the serialized document. The lab
does not map those strings to an app-server client or listen to live Codex
events.

## Machine state

The machine starts with a complete output context:

```json
{
  "value": "loading",
  "context": {
    "provider": "Codex",
    "primary_percent": null,
    "primary_resets_at": null,
    "secondary_percent": null,
    "secondary_resets_at": null,
    "credit_balance": null,
    "has_credits": null,
    "plan_type": null
  }
}
```

The snapshot event has type `codex.usage.snapshot`. Its transition targets
`ready` and applies:

```json
{ "replaceContext": "$.data" }
```

The entire context becomes the rate-limit snapshot. The snapshot supplies the
provider, both usage windows, credit fields, and plan fields. The initial
context supplies the same field set before a snapshot exists.

The update event has type `codex.usage.updated`. Its transition targets
`ready` and applies a sparse patch:

```json
{
  "patchContext": {
    "primary_percent": "$.data.primary_percent",
    "primary_resets_at": "$.data.primary_resets_at"
  }
}
```

The runtime implements the machine with `scan`. `replaceContext` reads one
object from the event and stores it as the next context. `patchContext` reads
the configured fields and spreads them over the previous context. The update
therefore changes the primary window while retaining the snapshot's secondary
window, credits, provider, and plan fields.

The initial context makes a sparse update valid before a snapshot. The patch
replaces the two primary fields, while the remaining projected fields retain
their null values. `project` consequently emits a structurally complete row.
The fixture has deterministic coverage for both update-before-snapshot and
snapshot-before-update ordering.

## Machine and sharing lifetime

The flow expression is compiled once for the canonical flow instance. The
machine's `scan` accumulator is created when that compiled flow's upstream
subscription begins. `shareReplay({ bufferSize: 1, refCount: true })` is the
outer flow operator, after `project`.

For overlapping subscribers, the lifetime is:

```text
first root subscriber
  -> one source subscription
  -> one scan accumulator

second root subscriber
  -> joins the replayed shared flow

first subscriber leaves
  -> source and machine remain active

final subscriber leaves
  -> refCount unsubscribes upstream

later subscriber
  -> new source subscription and fresh initial machine state
```

This is one machine instance for the active compiled-flow subscription sharing
lifetime. Subscriber count does not create one independent machine context per
subscriber while the shared subscription remains active.

## Dashboard emissions

The machine output is projected from `$.context` into the Codex usage fields.
The v2 runtime then maps the located object to:

```ts
type DashboardEmission = {
  ruleId: string;
  url: string;
  ts: number;
  matches: JsonObject[];
  stream: string;
  schema: Record<string, unknown>;
};
```

Codex rows use `stream: "codex.usage"`. Their `url` and `ts` come from the
host event that caused the current machine emission. The snapshot row uses the
`account/rateLimits/read` origin. The update row uses the
`account/rateLimits/updated` origin.

The existing Claude v2 fixture emits the same envelope with
`stream: "claude.usage"`. `12_codex-v2.test.ts` constructs the future combined
row input with:

```ts
merge(
  claude.roots["claude.usage"],
  codex.roots["codex.usage"],
)
```

The resulting Observable contains two stream identities in one
`DashboardEmission` row sequence. This gives a future two-stream Metrics view
one row contract and lets the view select `claude.usage` or `codex.usage` by the
existing `stream` field. The test observes the rows in memory. Persistence,
`rulematch` transport, live host bindings, and production rendering are not
part of the lab.

## Production status

The v2 source, machine, and output documents are isolated under
`labs/json-rx-mvp`. The current production Claude rule remains v1 data and is
imported by the Claude fixture for comparison. The production extension and
server do not compile `AutomationV2`, create these host-event Observables, or
forward these v2 roots. A future adapter would need to provide those bridges
before the two fixtures could supply live Metrics rows.
