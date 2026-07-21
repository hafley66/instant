# JSON-Rx MVP lab

This directory is isolated from Instant's running application, extension, Rust
server, and `src/lib/json-rx`. It tests serialized circuits against RxJS 7.8.
The files here are an executable v2 reference fixture. They do not constitute a
production Codex host integration or change the production v1 Rule JSON path.

## Current v2 circuits

The Claude fixture keeps the existing browser network-response shape:

```text
browser.network.response -> project -> shareReplay(1, refCount=true)
```

The Codex fixture models two host-event bindings and joins their event streams:

```text
host.event account/rateLimits/read       \
                                           -> merge -> scan(reducer) -> shareReplay
host.event account/rateLimits/updated    /
```

The bindings declare these operation names:

```text
account/rateLimits/read
account/rateLimits/updated
```

The lab supplies the corresponding `HostEvent` Observables directly to
`compileAutomationV2`. An operation name is a source-binding identifier here;
the lab contains no app-server listener, operation dispatcher, authentication,
or host event transport.

## Scan accumulator updates

The Codex reducer starts with a structurally complete seed: `provider` is
`"Codex"`, and every usage, reset, credit, and plan field is present with a
`null` value. A `codex.usage.snapshot` case uses `replace: "$.data"`, replacing
the whole accumulator with the snapshot object. A `codex.usage.updated` case
uses `patch` for
`primary_percent` and `primary_resets_at`, merging those fields into the
the existing accumulator while retaining the other snapshot or seed fields.

The scan expression lowers directly to RxJS `scan`. The expression is compiled once
as part of the flow graph. `scan` allocates its accumulator when the flow's
upstream subscription begins. The `shareReplay` operator follows `scan`, so
overlapping subscribers share one upstream subscription and one accumulator
lifetime. When the final subscriber leaves,
`refCount` tears down that lifetime. A later subscription starts a fresh
accumulator from the reducer seed.

The sparse update is valid before the snapshot. `scan` patches the null-filled
seed and emits a structurally complete row with nulls for
fields that the update does not carry. The fixture has deterministic coverage
for both update-before-snapshot and snapshot-before-update ordering.

## Dashboard row stream

Each v2 output maps to the existing `DashboardEmission` shape:

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

The Codex root emits rows with `stream: "codex.usage"` and the Claude root
emits rows with `stream: "claude.usage"`. The Codex test merges both roots into
one Observable of `DashboardEmission` values, which models the input for a
future two-stream Metrics view. The test does not persist rows, invoke the
production `rulematch` transport, or mount a production Metrics panel.

The existing production Metrics consumer already defines the row envelope and
stream field. The v2 lab only verifies that both isolated fixtures produce that
shape. A future adapter would need to connect host bindings, subscribe roots,
and deliver these rows through the production transport.

## Supported grammar

The v2 compiler accepts these expression nodes:

```text
source
project
merge
scan
shareReplay(1, refCount=true)
```

Every expression node has an explicit stable node ID. Definition and instance
references use URLs. Zod 4 validates the document and graph references;
`z.toJSONSchema()` exports Draft 2020-12. The lab does not provide scheduler
profiles, queue policies, persistence, or Instant integration.

The project node declares `language: "jsonata"`. Its field expressions execute
against the object selected by `from`; missing expressions omit their fields.

## Run

```sh
corepack pnpm@10.12.4 exec vitest run --config labs/json-rx-mvp/5_vitest.config.ts
corepack pnpm@10.12.4 exec tsc --project labs/json-rx-mvp/6_tsconfig.json
```
