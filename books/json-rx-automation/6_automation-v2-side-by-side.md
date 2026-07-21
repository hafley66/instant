# Automation v2 behind compact Rule JSON

## Goal

Execute network-response rules through JSON-Rx automation v2 while preserving
the compact Rules editor format and dashboard transport.

```text
GET /config rules[]
  -> netcapture ruleToAutomationV2 adapter
  -> production v2 compiler + browser source binding
  -> existing rulematch dashboard transport
```

The production compiler lives under `src/lib/json-rx`. The browser adapter is
`extension/src/6_v2Rules.ts`. `labs/json-rx-mvp` remains an isolated
conformance fixture. Selector and text-node scans retain their compact direct
interpreters; netcapture projection executes through v2.

## Version boundaries

Rule JSON remains the compact authoring format:

```json
{
  "id": "claude-usage",
  "mode": "netcapture",
  "request": {},
  "response": {},
  "emit": {}
}
```

The extension deterministically lowers that document into v2 host bindings,
the temporal circuit, and root subscriptions:

```json
{
  "version": "automation.v2",
  "profile": "rxjs-7.8",
  "id": "jsonrx://instant/automations/claude-usage",
  "bindings": {
    "sources": {}
  },
  "circuit": {
    "sources": {},
    "reducers": {},
    "flows": {}
  },
  "outputs": []
}
```

## Zod and JSON Schema

Zod 4 defines the TypeScript authoring and runtime validation schema:

```text
unknown JSON
  -> AutomationV2Schema.parse
  -> typed automation
  -> reference and node-identity checks
  -> compiler
```

`z.toJSONSchema()` exports Draft 2020-12 for portable tooling and future Rust
validation. Zod remains an implementation dependency of the TypeScript
reference profile. The generated JSON Schema is the interchange artifact.

## Claude usage equivalence fixture

The v2 fixture imports the current Claude v1 rule as comparison data. It uses
the same:

- page host expression
- HTTP method set
- request URL expression
- response extraction paths
- dashboard stream
- dashboard JSON Schema

Its circuit is:

```text
browser network response
  -> project fields from $.body
  -> shareReplay(1, refCount=true)
  -> dashboard root subscription
```

The v2 runtime carries capture provenance beside the projected value:

```ts
type LocatedValue = {
  value: JsonValue;
  origin?: {
    url: string;
    ts: number;
  };
};
```

Projection changes `value` and preserves `origin`. Dashboard emission removes
the internal wrapper and produces the existing wire shape:

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

The canonical automation instance URL occupies `ruleId`. Existing activity
storage and Metrics queries can therefore consume v1 and v2 emissions through
one envelope.

## Canonical IR

The lab parses the document, applies Zod defaults, recursively sorts object
keys, and serializes the result:

```text
parsed automation
  -> canonical object-key order
  -> JSON.stringify
  -> canonical IR bytes
```

Two input objects with different property insertion orders produce identical
canonical bytes. Array order remains semantic.

This IR currently proves deterministic normalization. A later compiler can add
resolved references, generated node addresses, inferred schemas, and profile
defaults before canonical serialization.

## Validation beyond JSON Schema

The Zod schema performs graph checks that ordinary structural JSON Schema does
not express directly:

- every source binding references a declared source
- every source expression references a declared source
- every output references a declared flow
- node IDs are unique across the automation circuit

Compilation fails before any source subscription when those checks fail.

## Sharing proof

Two overlapping subscribers to the v2 dashboard root produce:

```text
subscriber A starts
  -> source acquisitions = 1

subscriber B starts
  -> source acquisitions = 1

subscriber A leaves
  -> source releases = 0

subscriber B leaves
  -> source releases = 1
```

This fixture guards the placement of `shareReplay`. The earlier MVP test caught
a compiler that cached an Observable wrapper while constructing the sharing
operator separately per subscription.

## Live adapter seam

The production compiler receives host-owned Observable bindings through one
additive adapter:

```text
GET /config rules[]
  -> rulesForHost
  -> ruleToAutomationV2 for each netcapture extraction rule
  -> validate and compile
  -> subscribe declared dashboard roots

page fetch/XHR response
  -> method and URL gate
  -> NetworkResponse Subject
  -> JSONata project
  -> shareReplay root
  -> POST existing rulematch envelope
```

The persisted Rules files require no migration because the compact format is an
authoring syntax lowered at runtime. Config replacement disposes all previous
root subscriptions before constructing the new per-page runtime set. Codex has
typed normalized host contracts and a deterministic fake source; live native
or Sprefa transport remains pending because browser ChatGPT capture supplies
the production Codex usage stream.

## Proven scope

The production and lab surfaces prove:

1. V1 and v2 remain independently versioned documents.
2. V2 survives a JSON serialization round trip.
3. Zod validates its structural and graph constraints.
4. Zod exports Draft 2020-12 JSON Schema.
5. Canonical IR is independent of object insertion order.
6. Claude network responses project into the existing metric fields.
7. V2 emits the existing dashboard envelope with original URL and timestamp.
8. Overlapping root subscribers share one network source acquisition.
9. The production Metrics panel derives one or two stream views from one
   database read.

Browser source matching, extension v2 execution, expression diagnostics,
dashboard transport, persistence, and generic Metrics rendering are production
code. Arbitrary serialized v2 documents in `/config` and live native Codex host
transport remain outside this adapter.
