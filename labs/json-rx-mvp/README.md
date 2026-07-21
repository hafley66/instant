# JSON-Rx MVP lab

This directory is isolated from Instant's running application and from
`src/lib/json-rx`. It tests a narrow serialized circuit against RxJS 7.8.

## Proof obligations

1. A reusable definition has a URI template.
2. Filled path and query parameters produce one canonical instance URL.
3. A runtime returns one Observable object for one canonical flow instance.
4. `shareReplay({ bufferSize: 1, refCount: true })` shares one source acquisition
   inside that instance.
5. A `switchMap` binding can project an outer value into the path and query
   parameters of an inner flow reference.
6. Replacing the outer value releases the prior inner flow and source.
7. RxJS terminal notifications lower into serializable `next`, `error`, and
   `complete` records.

## Supported grammar

The compiler accepts five expression nodes:

```text
source
of
map.get
switchMap.ref
shareReplay(1, refCount=true)
```

Every expression node has an explicit stable node ID. Definition and instance
references use URLs. This lab has no generic expression language, protocol
binding vocabulary, scheduler profile, queue policy, persistence, or Instant
integration.

## Side-by-side automation v2

The v2 lab adds a deployment envelope around the circuit while leaving the
production v1 Rule JSON untouched:

```text
automation.v2
  browser network-response source binding
  source -> project -> shareReplay circuit
  dashboard root subscription metadata
```

Zod 4 is the TypeScript authoring and runtime-validation implementation.
`z.toJSONSchema()` exports the portable Draft 2020-12 schema. The v2 fixture
imports the production Claude v1 rule only as comparison data.

Future server coexistence is additive:

```json
{
  "rules": [],
  "automations": []
}
```

The current extension continues reading `rules`. A future v2 adapter validates
and compiles `automations`, subscribes declared roots, and sends the existing
`rulematch` dashboard envelope. The v2 automation URL occupies `ruleId`, so the
current database and Metrics query shape require no second transport.

## Run

```sh
corepack pnpm@10.12.4 exec vitest run --config labs/json-rx-mvp/5_vitest.config.ts
corepack pnpm@10.12.4 exec tsc --project labs/json-rx-mvp/6_tsconfig.json
```
