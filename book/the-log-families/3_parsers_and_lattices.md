---
title: Parser Machinery and Lattice Answers
author: Chris Hafley
---

# Definite clause grammars

A DCG gives grammar rules a Prolog surface:

```prolog
pipeline(pipe(Source, Operators)) -->
    source(Source),
    operators(Operators).
```

The conventional translation adds two arguments representing an input and
output token-list tail:

```prolog
pipeline(pipe(Source, Operators), Start, End) :-
    source(Source, Start, Mid),
    operators(Operators, Mid, End).
```

The same translation can use integer token positions:

```text
nonterminal(start_position, end_position, syntax_value)
```

That representation is already relational. A bottom-up engine can materialize
recognized spans, while a Prolog engine can demand spans from a particular
start position.

DCGs support semantic values because grammar nonterminals are predicates with
ordinary arguments. They can construct AST terms, carry environments, emit
diagnostics, and invoke constraints while recognizing input.

<!-- end_slide -->

# Recursive descent versus chart evaluation

Ordinary SLD evaluation gives a DCG recursive-descent behavior. A left-recursive
grammar can re-enter the same goal before consuming input:

```prolog
expr(E) -->
    expr(A),
    [+],
    term(B),
    { E = add(A, B) }.
```

Tabled evaluation identifies the repeated call by its bound arguments. The
second call becomes a consumer of the first call's answer table.

```text
expr(Start, End, AST)
    -> table key expr(Start, _, _)
    -> answers add new End/AST pairs
    -> suspended recursive consumers resume
    -> completion after no new pairs
```

This is chart-shaped evaluation:

| Parser concept | Tabled logic concept |
| --- | --- |
| nonterminal at input position | tabled call |
| completed parse span | answer |
| waiting production | suspended consumer |
| chart entry | call/answer table |
| closure of chart | table completion |

Ambiguity is represented by several answers for the same nonterminal and span.
Answer subsumption can replace the set of all trees with a packed forest, best
tree, lowest cost, or another joined result.

<!-- end_slide -->

# Bottom-up DCGs inside Sprefa

A DCG can lower into ordinary typed relations:

```dl
rel token(pos: int, next: int, kind: TokenKind, text: text).
rel expr(start: int, end: int, value: Expr).

expr(start, end, value) <-
    term(start, plus_pos, left),
    token(plus_pos, right_pos, Plus, _),
    expr(right_pos, end, right),
    value = Add(left, right).
```

The input positions make the domain finite for one source revision. Semi-naive
evaluation computes the chart to closure.

Useful stored identities are:

```text
(path, revision, grammar_symbol, start, end, syntax_hash)
```

Retraction follows file revision replacement. Incremental reparsing can preserve
unaffected token and span facts when edit ranges and parser dependencies are
available.

The bottom-up parser naturally computes every requested grammar relation. Magic
or demand relations can restrict work to roots, changed regions, or editor
queries.

<!-- end_slide -->

# Bidirectional grammar limits

Pure relational grammar rules can sometimes run in both directions:

```text
parse(Source, AST)
print(AST, Source)
```

Operational behavior depends on:

- which arguments are ground;
- whether the term and token domains are finite;
- rule and goal ordering in a search evaluator;
- whether semantic actions are relational;
- ambiguity and normalization policy;
- the answer aggregation strategy.

A practical compiler can declare modes explicitly:

```text
grammar Expr {
    parse(tokens: in) -> expr: out semidet
    print(expr: in) -> tokens: out det
}
```

Mercury's mode and determinism system is direct prior art. Separate generated
parse and print plans can share one declarative grammar while receiving
different indexes and execution strategies.

<!-- end_slide -->

# Constraints during parsing

Parser rules frequently need information beyond context-free recognition:

- binary lengths and offsets;
- indentation and layout;
- checksums;
- scoped names;
- type compatibility;
- format-version conditions;
- dependent field shapes.

CLP-style variables allow a grammar to emit constraints before all values are
known:

```text
PayloadEnd = PayloadStart + Header.length
FieldType <: ExpectedType
Name resolves_in Scope
```

CHR-style rules can propagate local consequences:

```text
declares(Scope, Name, Symbol), refers(Use, Scope, Name)
    ==> resolves(Use, Symbol)
```

DaeDaLus is relevant where the grammar itself is the authoritative typed
description of a binary format. λProlog is relevant where parsed syntax
contains binders whose scope and substitution should be represented
hygienically.

<!-- end_slide -->

# Answer subsumption

Ordinary tabling stores a set of answers for each tabled call. Answer
subsumption equips answer positions with an order or join operation.

```text
CallKey -> AnswerLattice
```

Insertion becomes:

```text
candidate = derive(call)
next = join(previous, candidate)
if next changed:
    store next
    resume dependent consumers
```

Common instances:

| Answer domain | Join | Meaning |
| --- | --- | --- |
| Boolean | `or` | whether any proof exists |
| set | union | all distinct answers |
| minimum cost | `min` | shortest or cheapest proof |
| maximum score | `max` | best scoring proof |
| type approximation | least upper bound | combined possible type |
| constant propagation | flat lattice join | known constant or unknown |
| parse forest | packed-node union | all derivations without tree duplication |

XSB calls this answer subsumption. SWI exposes mode-directed tabling and custom
lattice joins. Picat exposes `min` and `max` table modes.

<!-- end_slide -->

# Datalog lattices

Lattice Datalog associates relation keys with values that grow according to a
partial order:

```text
Relation<Key, LatticeValue>
```

Instead of inserting every candidate tuple, the engine joins the new value
with the value already stored at the key.

```text
state[key] := state[key] join delta[key]
```

This supports analyses such as:

- reaching definitions;
- constant propagation;
- interval analysis;
- taint sets;
- possible type unions;
- shortest paths under appropriate ordering;
- dataflow facts with widening.

Flix extends first-class Datalog constraints with lattice semantics. Datafun
tracks monotonicity through types so higher-order functions can participate in
least fixed points. egglog uses lattices for cooperating analyses over
e-classes.

<!-- end_slide -->

# One abstraction across tabled and bottom-up engines

The storage interface can be shared:

```text
trait JoinTable<Key, Value> {
    join(key: Key, candidate: Value) -> Changed<Value>
    get(key: Key) -> Value?
    subscribe(key: Key, consumer: Consumer)
}
```

The engines differ in how they produce keys and candidates:

```text
Bottom-up Datalog
    rule joins -> relation key/value candidates

Tabled Prolog
    call execution -> answer key/value candidates

Chart parser
    grammar completion -> span/forest candidates

Incremental type checker
    constraint propagation -> symbol/type candidates
```

The same join law is required:

```text
associative
commutative
idempotent
```

Those laws make insertion order irrelevant and guarantee convergence for a
finite-height lattice or a widening-controlled ascending chain.

<!-- end_slide -->

# Parsing JSON-RX with the hybrid

A surface rule can produce typed constructor terms:

```prolog
pipeline(pipe(Source, Operators)) -->
    identifier(Source),
    [pipe],
    operator_list(Operators).
```

Normalized facts:

```text
flow(flow_id, source_id)
flow_step(flow_id, 0, map(transform_id))
flow_step(flow_id, 1, scan(reducer_id, seed_id))
flow_step(flow_id, 2, share_replay(1, true))
```

Type flow uses lattice answers:

```text
output_type(node) = join(all inferred output alternatives)
```

Generated target terms use Rust-shaped enums:

```rust
enum Event {
    Snapshot(UsageSnapshot),
    Update(UsageUpdate),
}
```

The formatter and auto-zone generator render selected normalized terms back
into source, TypeScript, Rust, JSON Schema, or OpenAPI artifacts.

