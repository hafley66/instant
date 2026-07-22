---
title: Datalog and the Hybrid Systems
author: Chris Hafley
---

# Soufflé: typed compiled Datalog

Soufflé compiles Datalog into relational algebra and native code. Its runtime
centers on indexed relations, generated join loops, dependency analysis,
semi-naive deltas, and component fixpoints.

Its current type system includes:

- primitive symbols and numeric types;
- nominal subtypes;
- records;
- recursive records;
- algebraic data types;
- constructor branches and destructuring.

Example ADT:

```souffle
.type Expression =
    Number { value: number }
  | Variable { name: symbol }
  | Add { left: Expression, right: Expression }
```

This crosses the representation boundary from flat SQL-like tuples to
Rust-shaped recursive data. See [Soufflé types](https://souffle-lang.github.io/types).

Soufflé remains relation-driven. It does not supply general Prolog call stacks,
reversible substitutions, fair relational search, or arbitrary query modes.

<!-- end_slide -->

# Flix: functional language with first-class Datalog

Flix combines:

- Hindley-Milner-style inference;
- algebraic data types and pattern matching;
- higher-order functions;
- higher-kinded types;
- extensible records;
- effects and handlers;
- first-class typed Datalog constraint values;
- schema-row polymorphism.

A constraint schema can be typed as:

```flix
#{ Edge(Int32, Int32), Path(Int32, Int32) }
```

Schema rows allow polymorphic composition over open relation collections.
Datalog programs can be constructed, passed to functions, combined, solved,
and returned as values.

The [Flix first-class constraints paper](https://flix.dev/paper/oopsla2020a.pdf)
describes modular typing and compile-time stratification. The
[2025 language-integrated Datalog paper](https://plg.math.uwaterloo.ca/~olhotak/pubs/oopsla25b.pdf)
describes the current architecture.

Flix is the closest language-surface precedent for Rust-like ADTs plus typed,
composable Datalog. Its Datalog appears as a distinguished constraint value
inside the functional language.

<!-- end_slide -->

# Formulog: typed functions inside Datalog

Formulog extends Datalog with:

- algebraic data types;
- pattern matching;
- a typed first-order functional sublanguage;
- constructor terms;
- SMT formula construction and solving;
- parallel bottom-up evaluation.

Its motivating use is static analysis whose rules need to construct and inspect
logical formulas. A functional expression can normalize a term or build an SMT
formula while Datalog rules handle global recursive propagation.

See the [Formulog extended paper](https://arxiv.org/abs/2009.08361).

Formulog is a close precedent for:

```text
bottom-up type-flow relations
    + Rust-shaped event and type terms
    + pure reducer/helper functions
    + external logical solvers
```

It provides less Prolog-style multi-directional invocation and parser syntax
than the proposed Sprefa mutation.

<!-- end_slide -->

# egglog: Datalog plus equality saturation

egglog unifies Datalog-style rules with equality saturation. It supports:

- constructor terms;
- relational queries over terms;
- e-classes and congruence closure;
- rewrite rules;
- semi-naive execution;
- lattice-style analyses;
- extraction of a selected representative term.

```text
facts + rewrites
    -> relational matches
    -> term construction
    -> equality unions
    -> congruence rebuilding
    -> saturation
    -> cost-based extraction
```

The [egglog PLDI paper](https://www.mwillsey.com/papers/egglog) explicitly
positions the system as a fusion of Datalog and equality saturation.

egglog is close when type aliases, normalized pipeline forms, and target
expressions should be equivalent rather than merely related. It supplies
unification modulo an evolving equivalence relation, while Prolog supplies
substitution-based syntactic unification during proof search.

<!-- end_slide -->

# Datafun: higher-order functional Datalog

Datafun generalizes Datalog into a higher-order functional language. Its key
type-system distinction tracks which functions are monotone.

```text
discrete values
monotone values
semilattice collections
least fixed points
```

Monotone functions can safely participate in fixed-point computation. Later
work develops seminaive evaluation for the higher-order setting.

See [Datafun: a functional Datalog](https://doi.org/10.1145/3022670.2951948).

Datafun is theoretically close to reactive and incremental language design:

```text
typed functions
    + monotonicity effects
    + lattice-valued collections
    + least fixed points
    + derivatives or deltas
```

It offers less parser, term-unification, and systems-language machinery than
the Prolog and Mercury branches.

<!-- end_slide -->

# Dyna: terms with agenda and chart evaluation

Dyna uses logic-programming-style structured terms and inference rules with an
agenda/chart runtime. Its vocabulary comes from both parsing and logic:

- items and charts;
- agenda scheduling;
- inference antecedents and consequents;
- assertion and retraction;
- weighted aggregation;
- structured terms and variables.

See [Dyna: A Declarative Language for Implementing Dynamic Programs](https://aclanthology.org/P04-3032/).

Dyna is close to the desired internal shape:

```text
Prolog-shaped terms and rules
    + incremental chart maintenance
    + weighted answer aggregation
    + agenda-driven execution
```

Its runtime differs from both WAM backtracking and whole-program relational
saturation. Work is scheduled as affected chart items enter the agenda.

<!-- end_slide -->

# DaeDaLus and Dedalus

The similarly named systems belong to different families.

## Galois DaeDaLus

DaeDaLus is a typed language and toolchain for precise binary-format
descriptions and generated safe parsers. It contributes:

- executable grammar specifications;
- typed semantic values;
- format constraints;
- parser generation;
- formal analysis of parser behavior.

See [Galois DaeDaLus](https://www.galois.com/project/daedalus).

## Berkeley Dedalus

Dedalus adds explicit time and location to Datalog for distributed systems. It
models state evolution, asynchronous messages, delay, persistence, and temporal
stratification. See [Dedalus: Datalog in Time and Space](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-173.html).

DaeDaLus is a parser-language cousin. Dedalus is a temporal/reactive Datalog
cousin.

<!-- end_slide -->

# Functional-logic cousins

Mercury, Curry, and Oz explore different combinations of functions, logic
variables, types, and concurrency.

## Mercury

Static types, modes, determinism, ADTs, purity, and compiled predicates.

## Curry

Typed lazy functional programming plus logic variables, narrowing, and
nondeterminism. Narrowing chooses rewrite rules while solving constructor
constraints.

## Oz

Dataflow variables, records, constraint stores, search spaces, concurrency, and
multiple declarative paradigms within one language.

These systems are close to rich term computation and typed pattern matching.
Their primary execution models are goal-, rewrite-, or constraint-driven rather
than semi-naive relation maintenance.

<!-- end_slide -->

# Closest and farthest cousins

Distance depends on the selected axis.

| Requirement | Closest systems | More distant systems | Reason |
| --- | --- | --- | --- |
| bottom-up typed relations | Soufflé, Formulog, Flix | miniKanren, Mercury | evaluator and store shape |
| compound terms plus fixpoints | XSB, Formulog, egglog | SQL, plain Datalog | structured values participate in recursion |
| Rust-like ADTs and match | Mercury, Flix, Formulog, Soufflé | ISO Prolog | explicit static sum types |
| DCG and relational parsing | SWI, XSB, λProlog | Datafun, Dedalus | grammar and unification machinery |
| lattice-valued answers | XSB, SWI, Picat, Flix | ordinary SLD Prolog | subsumption or lattice joins |
| incremental repository database | Sprefa, Differential Datalog relatives | Mercury, miniKanren | maintained materialized state |
| equality normalization | egglog | Picat, Dedalus | congruence closure and extraction |
| binary-format parsing | DaeDaLus | Datafun, XSB | grammar specialization and parser generation |
| temporal distributed logic | Dedalus, Bloom relatives | DaeDaLus, Mercury | explicit logical time and location |

