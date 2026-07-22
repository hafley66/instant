---
title: Capability Matrix and the Sprefa Design Space
author: Chris Hafley
---

# Capability legend

The matrix uses these values:

| Mark | Meaning |
| --- | --- |
| `Y` | central supported capability |
| `P` | partial, restricted, library-based, or secondary capability |
| `E` | embedding or extension supplies it |
| `N` | absent from the core model considered here |

The rows compare language and runtime families rather than interchangeable
products. A `Y` does not imply identical semantics between systems.

<!-- end_slide -->

# Large intersection matrix

| System/family | Goal search | Bottom-up fixpoint | Tabling | Incremental maintenance | Compound terms | Static ADTs | Pattern match | General unification | DCG/parser DSL | Constraints | Lattice answers | Higher-order | Negation model | Native/codegen target | Temporal/reactive |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | --- | --- | :---: |
| ISO/Edinburgh Prolog | Y | N | N | P | Y | N | P | Y | Y | E | N | P | negation as failure | bytecode/native varies | N |
| SWI-Prolog | Y | P | Y | Y | Y | N | P | Y | Y | Y | Y | Y | SLG WFS plus NAF | VM/native foreign boundary | P |
| XSB | Y | P | Y | Y | Y | N | P | Y | Y | Y | Y | P | well-founded semantics | SLG-WAM | P |
| Picat | Y | P | Y | N | Y | P | Y | Y | P | Y | Y | P | ordered rules/NAF | bytecode/VM | P |
| Mercury | Y | N | P | N | Y | Y | Y | typed/mode-directed | Y | P | N | Y | pure logical negation restrictions | native C/JVM/etc. | P |
| λProlog/Teyjus | Y | N | N | N | Y | Y | Y | higher-order pattern | E | P | N | Y | hereditary Harrop logic | dedicated VM | N |
| miniKanren | Y | N | E | N | Y | N | P | Y | E | E | N | E | disequality/constraint variants | host language | N |
| Logtalk | Y | N | backend | backend | Y | N | P | Y | Y | backend | backend | Y | backend semantics | transcompiled to Prolog | P |
| CHR | N | P | N | P | Y | N | Y | host unification | E | Y | P | P | committed-choice guards | host Prolog/other | P |
| Soufflé | N | Y | N | P | Y | Y | Y | pattern binding | N | P | P | N | stratified negation | generated C++ | N |
| Sprefa current | N | Y | N | Y | normalized | typed relations | P | relational variables | grammar ops | P | P | N | stratified negation | Rust/SQLite runtime + gen | Y |
| Flix | P | Y | P | P | Y | Y | Y | typed relational binding | parser libraries | Y | Y | Y | stratified Datalog + effects | JVM | Y |
| Formulog | N | Y | N | N | Y | Y | Y | rule binding | N | SMT | P | first-order functions | stratified Datalog | native/parallel runtime | N |
| Datafun | N | Y | N | theoretical/derived | Y | Y | Y | functional binding | N | monotonicity types | Y | Y | monotone fixed points | research implementation | P |
| egglog | N | Y | N | Y | Y | typed sorts | Y | equality-aware matching | N | equality/congruence | Y | P | monotone rules | Rust engine | P |
| Dyna | P | P | chart | Y | Y | P | P | Y | chart-oriented | weighted | Y | P | rule aggregation | research runtime | Y |
| DaeDaLus | N | N | parser memoization | N | Y | Y | Y | grammar binding | Y | format constraints | N | P | parser choice semantics | generated parsers | N |
| Dedalus | N | Y | N | temporal state | flat/records | P | N | relational variables | N | temporal constraints | P | N | temporal stratification | distributed runtimes/research | Y |
| Curry | Y | N | P | N | Y | Y | Y | narrowing/unification | E | constraints | N | Y | functional-logic search | native/VM varies | P |
| Oz | Y | P | P | Y | Y | P | Y | dataflow unification | E | Y | P | Y | computation spaces | Mozart VM | Y |
| SQL recursive CTE | N | Y | N | DB-dependent | records/JSON | schema types | N | equality joins | N | checks/domains | aggregates | N | three-valued SQL | database engine | P |

<!-- end_slide -->

# Evaluation and storage matrix

| System | Primary work item | Memoized identity | Stored result | Recursion completion | Change propagation |
| --- | --- | --- | --- | --- | --- |
| WAM Prolog | selected goal | active call frame | current substitution | alternatives exhausted | rerun query |
| XSB/SWI SLG | tabled call pattern | call trie entry | answer substitutions | completion of dependency component | incremental tables where enabled |
| Picat | mode-keyed table call | `+` arguments | selected `-`/`min`/`max` answer | linear table fixpoint | rerun table computation |
| Soufflé | rule/delta tuple | relation primary tuple | relation tuple | SCC delta becomes empty | batch recomputation or extensions |
| Sprefa | source/relation delta | relation primary key plus revision | SQLite relation rows | stratum/SCC delta becomes empty | revision retraction and downstream fixpoint |
| CHR | newly active constraint | constraint-store occurrence | rewritten constraint multiset | no applicable rules | local propagation |
| egglog | rule match/e-node | canonical e-class | facts, nodes, equalities | saturation reaches quiescence | incremental insertion-oriented execution |
| chart parser | grammar item/span | symbol and start position | completed spans/forest | agenda empty | incremental chart invalidation |
| Datafun | monotone function delta | lattice location | semilattice value | least fixed point | semantic derivative/delta |

<!-- end_slide -->

# Type-system matrix

| System | Type identity | Sum/product data | Polymorphism | Relation/schema typing | Modes/effects | Exhaustiveness |
| --- | --- | --- | --- | --- | --- | --- |
| Prolog | dynamic term shape | constructors by convention | runtime terms | predicate conventions | instantiation inferred operationally | no static check |
| Mercury | nominal/static | ADTs, tuples, records | parametric | predicate signatures | modes and determinism | compiler checked |
| λProlog | simply typed higher-order terms | typed constructors | polymorphic | predicate types | logical scoping | typed clauses/patterns |
| Soufflé | nominal relation attributes | records and ADTs | components rather than general parametric types | static declarations | relation direction fixed | ADT branch checks vary by construct |
| Flix | HM-style static types | enums, tuples, extensible records | parametric and higher-kinded | schema-row polymorphism | effects and relation schemas | compiler checked |
| Formulog | static first-order types | ADTs | parametric facilities | typed relations | pure function boundary | compiler checked |
| Datafun | typed lambda calculus | functional data | higher-order | semilattice-valued collections | monotonicity tracked in types | functional-language rules |
| TypeSpec | structural schema types | models, unions, tuples | templates | API/schema operations | decorators/visibility | union checking without general match expressions |
| proposed Sprefa | nominal symbols plus structural imported schemas | Rust-style enums and records | relations, type functions, schema rows | typed ports and relations | evaluation mode, determinism, monotonicity | reducer/match closure relation |

<!-- end_slide -->

# Closest cousins by desired property

## Typed language surface

1. Flix
2. Mercury
3. Formulog
4. Soufflé ADTs

Flix covers the largest intersection of ADTs, pattern matching, polymorphism,
effects, and first-class Datalog. Mercury gives the clearest type/mode/
determinism discipline for logic predicates. Formulog places pure typed
functions directly inside bottom-up rules.

## Runtime evaluator

1. XSB SLG plus answer subsumption
2. Soufflé semi-naive RAM
3. Sprefa's SQLite fixpoint and retraction
4. Dyna's agenda/chart evaluator

XSB supplies demand and suspended consumers. Soufflé supplies optimized
bottom-up joins. Sprefa supplies persistent repository state and generation
sinks. Dyna supplies a structured-term incremental agenda.

## Parser

1. Tabled DCGs in SWI/XSB
2. DaeDaLus
3. λProlog lambda-tree syntax
4. Mercury DCGs

## Lattices and normalization

1. XSB/SWI answer subsumption
2. Flix lattice constraints
3. Datafun monotonicity
4. egglog lattices and congruence

<!-- end_slide -->

# Farthest cousins and retained lessons

Distance here means fewer shared implementation commitments with the proposed
Sprefa language.

| Cousin | Distance source | Retained lesson |
| --- | --- | --- |
| ordinary SQL | lacks terms, unification, parser rules, and sum types | durable indexes, query planning, transactions |
| ISO Prolog without tabling | lacks bottom-up materialization and incremental database state | terms, DCGs, interactive relational queries |
| miniKanren | lacks materialized relations, static types, and lattice tables | small relational core and fair search |
| DaeDaLus | lacks general recursive logic relations | precise typed grammar as executable specification |
| Dedalus | specializes toward distributed time | explicit event time, persistence, and asynchronous semantics |
| Datafun | theoretical functional fixed-point center | monotonicity as a type-level property |
| egglog | equality saturation changes term identity semantics | normalization, congruence, and extraction |
| Logtalk | primarily restructures program organization | protocols and reusable logic modules |

<!-- end_slide -->

# Proposed Sprefa semantic layers

```text
source text
  -> token and comment facts
  -> DCG/span relations
  -> typed constructor AST
  -> symbol and scope relations
  -> schema/OpenAPI imported types
  -> stream/operator type-flow relations
  -> normalized JSON-RX graph
  -> TS/RxJS and Rust/Tokio terms
  -> convergent auto zones
```

Each layer has a distinct storage identity:

| Layer | Key | Value |
| --- | --- | --- |
| token | path, revision, offset | token kind and text |
| parse | grammar symbol, start, end | AST or packed forest |
| symbol | namespace, declaration identity | kind, type, source span |
| type flow | graph node and port | type-lattice value |
| normalized graph | stable node address | operator and references |
| generated zone | path and zone name | rendered target bytes |

<!-- end_slide -->

# Proposed evaluator declarations

One language can expose evaluation as metadata rather than forcing every
predicate through one engine.

```text
pred parse_expr(TokenCursor, Expr)
    evaluation tabled
    mode in, out
    determinism multi
    answers packed_forest

rel inferred_type(Node, Type)
    evaluation bottom_up
    answers lattice(type_join)

pred synthesize(Type, Expr)
    evaluation search
    mode in, out
    determinism nondet

rel generated_zone(Path, Name, Text)
    evaluation bottom_up
    answers ordered_rows
```

The compiler can lower each declaration into a machine-specific plan:

- search plan with environments and choice points;
- table plan with calls, answers, and consumers;
- relational plan with indexes and deltas;
- constraint plan with attributed variables or CHR-like propagation.

<!-- end_slide -->

# Shared join-table substrate

Tabled answers and lattice relations can share one storage protocol:

```rust
trait JoinTable<K, V> {
    fn join(&mut self, key: K, candidate: V) -> Change<V>;
    fn get(&self, key: &K) -> Option<&V>;
}
```

Each domain supplies its join:

```text
set union
minimum cost
maximum score
type least-upper-bound
packed parse forest union
e-class union
ordered generated rows with uniqueness checks
```

Dependencies attach differently:

```text
bottom-up: relation -> rule -> relation
tabled: call -> consumer continuation -> answer
parser: span -> waiting production -> completed span
generation: source fact -> rendered zone -> file revision
```

<!-- end_slide -->

# JSON-RX example in the combined model

```text
model UsageInputs {
    snapshot: Stream<UsageSnapshot>
    update: Stream<UsageUpdate>
}

events = mergeByKey(UsageInputs)

state = scan(events, Usage {}, match {
    snapshot(value) => value
    update(patch) => state merge patch
})
```

Derived event type:

```text
UsageEvent =
    snapshot(UsageSnapshot)
  | update(UsageUpdate)
```

The derivation can feed:

- a Rust enum and exhaustive `match`;
- a TypeScript discriminated union and `switch`;
- JSON Schema `oneOf` branches;
- editor variant dropdowns;
- a `tokio::select!` branch for every keyed input;
- RxJS `map` plus `merge` inputs;
- an exhaustiveness diagnostic relation.

<!-- end_slide -->

# Outer source fixpoint and auto zones

Sprefa's generated zones support an outer compiler fixpoint:

```text
parse authored and generated zones
    -> derive semantic facts
    -> render generated declarations
    -> rewrite named zones
    -> reparse changed files
    -> repeat until bytes and relations stabilize
```

Required controls:

- generated zone identity is `(path, name)`;
- rendering is deterministic;
- byte-identical results skip writes;
- missing or repeated markers fail;
- iteration has a convergence limit;
- generated zones are no-touch ranges;
- diagnostics point to the owning declaration and generator.

This allows derived TypeSpec-compatible declarations, Rust enums, or JSON-RX
documents to remain visible beside authored source while their content stays
machine-owned.

<!-- end_slide -->

# Resulting lineage

```text
SQL and Soufflé
    indexed relations, joins, semi-naive fixpoints

SWI and XSB
    terms, DCGs, tabling, suspended consumers, answer lattices

Mercury and Flix
    ADTs, match, types, modes, effects, functional composition

Formulog and Datafun
    typed functions and monotone computation inside fixed points

egglog
    equality, normalization, lattice analyses, extraction

Dyna
    agenda/chart incremental inference over structured terms

Sprefa
    repository facts, retraction, provenance, diagnostics,
    source rewriting, and convergent generated zones
```

The proposed system occupies their shared intersection while keeping evaluator
choice, type identity, source ownership, and target lowering explicit.

