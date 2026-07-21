# Automation v2 beside Rule JSON v1

## Goal

Introduce JSON-Rx automation documents without changing the current extension
rule interpreter or dashboard transport.

```text
server config
  ├─ rules[]        -> existing v1 extension interpreter
  └─ automations[]  -> production v2 compiler + host-owned source bindings
```

The production implementation lives under `src/lib/json-rx` and is exported by
the Metrics plugin. `labs/json-rx-mvp` remains a historical conformance fixture.
The current extension still executes the v1 Claude rule; v2 definitions are
available for production-side compilation and do not replace that capture path.

## Version boundaries

V1 remains the current compact capture format:

```json
{
  "id": "claude-usage",
  "mode": "netcapture",
  "request": {},
  "response": {},
  "emit": {}
}
```

V2 separates host bindings, the temporal circuit, and root subscriptions:

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

## Current adapter seam

The production compiler receives host-owned Observable bindings through one
additive adapter:

```text
GET /config
  -> preserve rules[] behavior
  -> parse automations[]
  -> match browser source bindings
  -> deliver NetworkResponse values
  -> subscribe declared dashboard roots
  -> POST existing rulematch envelopes
```

No v1-to-v2 migration is required. Individual automations can be represented in
both formats during comparison. The Claude v2 definition is present in the
production Metrics plugin. Browser v2 source matching and persistence wiring
remain pending host work. Codex has typed normalized host contracts and a
deterministic fake source; live native or Sprefa transport remains pending.

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

The browser v2 source matcher, server config endpoint, extension v2 transport,
live Codex host transport, and persistence of v2 roots remain pending host work.
The Metrics plugin registration and generic comparison renderer are production
code.
