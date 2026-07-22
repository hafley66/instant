---
title: The Prolog Family
author: Chris Hafley
---

# Edinburgh and ISO Prolog

The central Prolog family includes SWI-Prolog, SICStus, GNU Prolog, YAP,
Ciao, Scryer, and Trealla. Their shared surface includes:

- atoms, numbers, variables, lists, and compound terms;
- first-order unification;
- SLD-style goal reduction;
- ordered clauses and body goals;
- backtracking and choice points;
- definite clause grammars;
- meta-predicates and dynamic predicates.

Implementations diverge in tabling, constraints, modules, indexing,
concurrency, attributed variables, compilation, foreign interfaces, and
standards coverage.

For the Sprefa design space, ordinary Prolog contributes term representation,
multi-directional predicates, DCG authoring, and interactive partially bound
queries. Its depth-first search and dynamic database semantics form separate
runtime choices from Sprefa's persistent relations and semi-naive evaluator.

<!-- end_slide -->

# XSB: Prolog as a deductive database

XSB is the strongest direct precedent for combining Prolog terms with
Datalog-like evaluation machinery.

Its relevant facilities include:

- SLG-WAM execution;
- variant and subsumptive tabling;
- answer tries and call tries;
- well-founded semantics for negation;
- answer subsumption;
- incremental tabling;
- tabled constraints;
- dependency and completion components.

Incremental tabling tracks dependencies between dynamic predicates and tabled
answers. An assertion or retraction can invalidate and recompute dependent
tables. [XSB's system description](https://xsb.sourceforge.net/about.html)
documents incremental propagation and answer subsumption.

XSB's internal dataflow is close to:

```text
call pattern
    -> subgoal trie
    -> producer execution
    -> answer trie insertion
    -> consumer wakeup
    -> completion component
```

Sprefa's analogues are relation identity, indexed tables, delta insertion,
dependency strata, and fixpoint completion. XSB adds query-local call identity
and suspended continuations.

<!-- end_slide -->

# SWI-Prolog: practical hybrid machinery

SWI-Prolog supplies ordinary Prolog, DCGs, constraints, attributed variables,
SLG tabling, answer subsumption, and incremental tabling in one maintained
system.

The table declaration changes recursive execution without changing predicate
syntax:

```prolog
:- table ancestor/2.
```

A tabled left-recursive call suspends when it encounters a variant of an active
call. New answers resume consumers. This makes tabled DCGs behave much more
like chart parsers than recursive descent.

SWI also supports mode-directed tabling. Selected answer arguments are joined
using modes such as minimum, maximum, or a user-defined lattice operation.
See [SWI answer subsumption](https://www.swi-prolog.org/pldoc/man?section=tabling).

This is a direct bridge between Prolog and lattice Datalog:

```text
answer_table[call_key] = join(previous, candidate_answer)
```

<!-- end_slide -->

# Picat: explicit modes and optimization tables

Picat combines:

- pattern matching;
- functions and predicates;
- explicit unification;
- explicit nondeterminism;
- constraints;
- linear tabling;
- mode-directed answer selection;
- planning libraries.

Example table modes:

```picat
table (+,+,-,min)
shortest_path(From, To, Path, Cost)
```

The modes mean:

| Mode | Meaning |
| --- | --- |
| `+` | part of the tabled call key |
| `-` | retained answer output |
| `min` | retain the least value for the key |
| `max` | retain the greatest value for the key |
| `nt` | exclude the argument from table identity |

Picat's linear tabling iteratively reevaluates looping calls until their tables
stabilize. Its planner uses tabling to find plans or optimal plans. See the
[Picat guide](https://picat-lang.org/download/picat_guide_html/picat_guide.html).

Picat is close to a language where each JSON-RX operator declares input modes,
output modes, determinism, and accumulation policy.

<!-- end_slide -->

# Mercury: typed logic with Rust-like data

Mercury combines Prolog-shaped predicates with:

- algebraic data types;
- exhaustive pattern matching;
- parametric polymorphism;
- functions and predicates;
- explicit modes;
- determinism declarations;
- modules and separate compilation;
- purity and controlled state threading;
- DCGs;
- native compilation.

A predicate signature can state:

```mercury
:- pred parse_expr(tokens::in, expr::out) is semidet.
```

Modes describe which arguments are already instantiated. Determinism describes
the permitted result cardinality:

| Determinism | Answer count |
| --- | --- |
| `det` | exactly one |
| `semidet` | zero or one |
| `multi` | one or more |
| `nondet` | zero or more |

The compiler uses these declarations to specialize unification and remove
unnecessary choice points or trailing. See the
[Mercury language introduction](https://mercurylang.org/information/doc-release/mercury_ref/Introduction.html)
and [current reference](https://mercurylang.org/information/doc-latest/mercury_reference_manual/index.html).

Mercury is the closest Prolog cousin to Rust enums and exhaustive match. Its
evaluator remains compiled goal-directed logic rather than bottom-up relation
saturation.

<!-- end_slide -->

# Constraint Logic Programming

Constraint Logic Programming delays decisions by placing constraints on logic
variables. Common domains include:

- `CLP(FD)` for finite-domain integers;
- `CLP(Q)` for rationals;
- `CLP(R)` for reals;
- Boolean, set, interval, and finite-set solvers.

```prolog
X #> 0,
Y #= X * 2,
Y #< 100.
```

Attributed variables attach solver-specific state to logical variables.
Unification triggers hooks that combine, propagate, or reject constraints.

A type-flow solver can use the same shape:

```text
Item(Stream) = T
Output <: Expected
Field(Record, Key) = Value
Variant belongs_to Union
```

The constraint store retains partial information while parsing, name
resolution, imported schemas, and operator flow progressively add facts.

<!-- end_slide -->

# Constraint Handling Rules

CHR is a committed-choice, forward-chaining, multi-headed constraint rewriting
language frequently embedded in Prolog.

```prolog
lower_bound(X, A), lower_bound(X, B) <=>
    C is max(A, B),
    lower_bound(X, C).
```

Rule classes include:

- simplification, replacing matched constraints;
- propagation, adding conclusions while retaining inputs;
- simpagation, retaining part of a matched constraint set;
- guarded multi-headed rules.

CHR occupies a useful middle position:

```text
Prolog terms and guards
    + forward chaining
    + mutable multiset constraint store
    + committed local rewrites
```

It has been used to implement type systems, unification extensions, solvers,
and grammar constraints. See the
[CHR implementation reference](https://exia.informatik.uni-ulm.de/fruehwirth/chr-thesis-book.html).

<!-- end_slide -->

# λProlog and Teyjus

λProlog changes the logical foundation from first-order Horn clauses to
higher-order hereditary Harrop formulas. It supplies:

- polymorphic typing;
- lambda terms as data;
- higher-order pattern unification;
- lexical binding in represented syntax;
- local assumptions and scoped predicates;
- quantification over functions and selected predicates;
- modules and abstract data types.

Lambda-tree syntax represents an object language's binders using host-language
binding. This avoids much manual alpha-renaming, capture avoidance, and
substitution code when implementing compilers or proof systems.

[Teyjus](https://teyjus.cs.umn.edu/) is a compiler and virtual-machine
implementation. Its documented use cases center on syntax trees containing
types, formulas, proofs, programs, and binders.

For a TypeSpec-descended language, λProlog is relevant to generic parameters,
scoped names, local declarations, and source-language binders.

<!-- end_slide -->

# miniKanren

miniKanren distills relational programming into:

- fresh logic variables;
- unification;
- conjunction and disjunction;
- fair interleaving search;
- reification of answer substitutions.

Unlike traditional depth-first Prolog, miniKanren interleaves branches so an
infinite failing branch does not permanently starve another branch. It normally
performs the occurs check. See the
[miniKanren comparison](https://minikanren.org/minikanren-and-prolog.html).

Its important compiler experiments are bidirectional relations:

```text
parse(Source, AST)
print(AST, Source)
infer(Expression, Type)
synthesize(Type, Expression)
```

miniKanren supplies a compact search and unification kernel. Persistent
materialized relations, change propagation, and lattice aggregation would
remain Sprefa responsibilities.

<!-- end_slide -->

# Logtalk and programming in the large

Logtalk adds reusable program structure around Prolog:

- objects and prototypes;
- protocols;
- categories and components;
- parametric objects;
- namespaces and predicate encapsulation;
- reflection, events, and portable backend support.

Its objects can be read as separately named predicate databases rather than
imperative mutable objects. See the [Logtalk handbook](https://logtalk.org/handbook/TheLogtalkHandbook-3.98.0.pdf).

Logtalk is relevant to packaging a logic standard library:

```text
parser protocol
schema importer category
type lattice object
operator vocabulary object
target emitter protocol
```

Its runtime semantics contribute less to the Prolog/Datalog fusion than XSB,
but its module and reuse model is pertinent to a large language ecosystem.

