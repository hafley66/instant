# Tentative plan: typed Pulse routes

Status: design checkpoint. Package boundary decided 2026-08-08.

## Package boundary

The route lives in `@hafley66/path`.

- `@hafley66/path` owns path syntax, typed path parameters, parsing, printing,
  matching, normalized route text, and the route declaration itself.
- `route(path, querySchema, payloadSchema)` returns path + schemas + `href` +
  `match`. It gains one runtime dependency: `zod`.
- The route does NOT own an event Signal. The caller attaches the Signal at the
  seam (decentralized wiring per the signal doctrine). `@hafley66/signals` stays
  out of path's dependencies. No separate `@hafley66/pulse-route` package.

The lab lands directly in `packages/path/src/` once the call shape settles.

## Declared surface

The route has exactly three arguments:

```ts
const Changed = route(
  `panel.${NumberPathParam("id")}.changed`,
  z.object({
    revision: z.coerce.number().int(),
    view: z.enum(["graph", "table"]).optional(),
  }),
  z.object({
    changed: z.boolean(),
    rows: z.array(z.string()),
  }),
)
```

Argument order:

1. path template
2. query schema
3. payload schema

Empty query or payload uses `z.object({})`. Emission is one unary object. Path,
query, and payload values are combined once:

```ts
Changed.href({
  id: 42,
  revision: 7,
  view: "graph",
  changed: true,
  rows: ["a", "b"],
})
// the caller's seam Signal is what emits:
Changed.$({...})   // attached at the seam, not owned by route()
```

## Type signatures

```ts
type NumberPathParameter<Name extends string> = `{number:${Name}}`

declare function NumberPathParam<const Name extends string>(
  name: Name,
): NumberPathParameter<Name>

type RoutePathInput<Path extends string> = unknown
type RoutePathOutput<Path extends string> = unknown
type NormalizeRoute<Path extends string> = string

interface PulseRoute<Input, Output, Path extends string> {
  readonly path: Path
  readonly schema: z.ZodType<Output, Input>
  href(value: Input): string
  match(text: string):
    | { matched: true; value: Output }
    | { matched: false; reason: "structure" | "values"; error?: unknown }
}

// The event Signal is attached by the caller at the seam:
type PulsingRoute<I, O, P extends string> = PulseRoute<I, O, P> & {
  $: Signal<O> & ((value: I) => void)
}

declare function route<
  const Path extends string,
  Query extends z.ZodObject,
  Payload extends z.ZodType,
>(
  path: Path,
  query: Query,
  payload: Payload,
): PulseRoute<
  RoutePathInput<Path> & z.input<Query> & z.input<Payload>,
  RoutePathOutput<Path> & z.output<Query> & z.output<Payload>,
  NormalizeRoute<Path>
>
```

The placeholder types above remain intentionally unresolved until the lab
proves TypeScript can retain the parameter name and scalar type through a
template literal without repeating either one.

## Pseudocode bodies

```ts
function NumberPathParam(name) {
  return `{number:${name}}`
}

function route(pathTemplate, querySchema, payloadSchema) {
  // compile the path template once
  // derive a Zod object for its named path parameters
  // intersect path, query, and payload schemas once
  // NO signal allocation here

  return {
    path: normalize(pathTemplate),
    schema: combinedSchema,
    href(value) {
      // parse the combined input
      // print path parameters into the normalized path
      // serialize only query-schema keys into URLSearchParams
    },
    match(text) {
      // match and parse path values
      // parse query values
      // combine them with a payload supplied at the ingress boundary
      // return the existing discriminated PathMatch shape
    },
  }
}

// seam helper (caller side, optional convenience):
function pulse<I, O, P extends string>(r: PulseRoute<I, O, P>): PulsingRoute<I, O, P> {
  return { ...r, $: Signal<O>() }   // bare event Signal, attached at the seam
}
```

`match(text)` still needs one settled detail: a URL contains path and query
values but no event payload. The lab should either expose `match(text,
payload)` or split URL parsing into `location(text)` and event validation into
the unary `.$(combinedValue)` call.

## Instance timelines

### Construction

1. Evaluate the template literal and retain its literal type.
2. Compile path segments and parameter codecs once.
3. Compose path, query, and payload Zod schemas once.
4. Return the route value used everywhere else as the source of its types. No
   Signal is allocated.

### Emit

1. The caller attaches a bare event Signal at the seam (optional `pulse(r)`
   helper, or inline `{ ...r, $: Signal() }`).
2. Caller passes one combined object to `Changed.$(...)`.
3. Combined schema parses/coerces it (the seam may call `match` or the schema
   directly before emitting).
4. The Signal emits the parsed output once.

### Print

1. `href(value)` validates the combined value.
2. Path keys print into path segments.
3. Query-schema keys print into the query string.
4. Payload-only keys are omitted from the URL.

### Match

1. Match normalized path structure.
2. Decode and coerce named path parameters.
3. Decode and validate query parameters.
4. Return the parsed location value or the existing structure/value failure.

## Storage and uniqueness

- A route declaration is the single stored source for path text, parameter
  types, query schema, payload schema, and inferred input/output types. The
  event Signal is NOT part of the declaration; it is attached at the seam.
- No registry is required for individual routes.
- A route collection may enforce unique normalized path templates when routes
  are assembled into an application router.
- Path, query, and payload object keys must be disjoint. Construction fails at
  compile time where detectable and at runtime otherwise.
- Signal delivery is ephemeral and caller-owned. Replay or retained state is a
  separate Signal choice and is not implied by `route()`.

## Lab acceptance cases

```ts
Changed.$({ id: 42, revision: "7", changed: true, rows: [] })
// output: { id: 42, revision: 7, changed: true, rows: [] }

Changed.href({ id: 42, revision: 7, changed: true, rows: [] })
// "panel.42.changed?revision=7"

Changed.$({ id: "forty-two", revision: 7, changed: true, rows: [] })
// deterministic Zod failure; no Signal emission
```

The type test must prove that `id`, `revision`, `changed`, and `rows` are
inferred from the one declaration and never restated in a companion type.
