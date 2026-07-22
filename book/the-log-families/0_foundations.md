---
title: The Logic Families, Foundations
author: Chris Hafley
---

# The shared logical core

Prolog and Datalog overlap on function-free Horn clauses:

```prolog
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
```

Both describe implications between atomic predicates. Both can interpret a
variable as ranging over values and a rule body as a conjunction. Under a
finite, pure, function-free program, goal-directed proof search and bottom-up
model construction can produce the same set of logical consequences.

The implementation divergence appears in what the runtime stores and which
piece of the program drives evaluation.

```text
Prolog computes proofs demanded by a goal.
Datalog computes a model implied by a program and its facts.
```

<!-- end_slide -->

# Goal reduction: the Prolog machine

Given:

```prolog
?- ancestor(alice, Who).
```

an SLD evaluator selects a goal, chooses a matching clause, unifies the goal
with the clause head, and replaces the goal with the instantiated clause body.

```text
ancestor(alice, Who)
    +-- parent(alice, Who)
    +-- parent(alice, Z), ancestor(Z, Who)
```

The classic Warren Abstract Machine organizes this work around:

- environments for active predicate calls;
- heap-allocated compound terms;
- registers holding arguments and temporary terms;
- choice points containing alternative clauses;
- a trail recording bindings that must be undone;
- continuations describing where execution resumes.

Failure is an execution event. The machine restores a choice point, untrails
bindings, selects another clause, and continues searching.

The output is an ordered stream of substitutions:

```prolog
Who = bob ;
Who = carol ;
Who = dana.
```

Clause order, body-goal order, indexing, and cuts can affect observable
execution even when the declarative reading remains similar.

<!-- end_slide -->

# Model construction: the Datalog machine

A bottom-up evaluator begins with extensional facts and applies every enabled
rule until no relation gains tuples.

```text
ancestor[0] = parent

ancestor[n+1] =
    ancestor[n]
    union join(parent, ancestor[n])
```

Semi-naive evaluation restricts recursive joins to newly derived tuples:

```text
delta[0] = parent

delta[n+1] =
    join(parent, delta[n])
    minus ancestor[n]
```

A Soufflé-like runtime stores:

- relations and tuple indexes;
- delta and accumulated relations;
- relational join plans;
- the rule dependency graph;
- strongly connected rule components;
- per-component fixpoint iteration state.

The output is a materialized least model:

```text
ancestor(alice, bob)
ancestor(alice, carol)
ancestor(alice, dana)
```

Tuple identity normally follows set semantics. Multiple proofs of one tuple
converge onto the same stored fact unless provenance is modeled explicitly.

<!-- end_slide -->

# The finite term boundary

Prolog normally permits recursive constructors:

```prolog
nat(0).
nat(s(N)) :- nat(N).
```

The Herbrand universe contains:

```text
0
s(0)
s(s(0))
s(s(s(0)))
...
```

A goal-directed evaluator can prove a bounded query:

```prolog
?- nat(s(s(0))).
true.
```

Bottom-up saturation over the same program continually discovers larger
terms. A finite fixpoint does not exist.

This yields a practical boundary:

```text
arbitrary term construction + full bottom-up saturation
    => potentially infinite materialization
```

Datalog systems recover termination through combinations of:

- a finite active domain;
- function-free rules;
- range-restricted variables;
- bounded constructor depth;
- guarded or finitely-ground rule classes;
- explicit widening or lattice convergence.

Soufflé supports recursive records and algebraic data types. Termination then
depends on programs avoiding unbounded constructor generation. See the
[Soufflé type documentation](https://souffle-lang.github.io/types).

<!-- end_slide -->

# Tabling: goal-directed fixpoints

Tabled Prolog stores calls and their answers. When a recursive call encounters
an existing table entry, it becomes a consumer of that table rather than
creating an indefinitely recursive stack.

```text
goal
  -> tabled call
  -> producer derives answers
  -> recursive consumers suspend
  -> new answers resume consumers
  -> completion detects no remaining answers
```

SLG resolution therefore computes a query-local fixpoint:

```text
SLG Prolog:
    goal-directed fixpoint over calls and substitutions

Datalog:
    program-directed fixpoint over relations and tuples
```

XSB combines Prolog execution with SLG tabling and well-founded semantics.
[XSB's tabling tutorial](https://xsb.sourceforge.net/shadow_site/manual1/node46.html)
describes termination for programs with bounded term depth.

SWI-Prolog exposes tabled execution through `table/1`. Left-recursive calls
suspend and consume later table answers. See
[SWI tabled execution](https://www.swi-prolog.org/pldoc/man?section=tabling).

<!-- end_slide -->

# Magic sets: demand inside bottom-up evaluation

Magic-set transformation begins with a query binding pattern and rewrites a
Datalog program to propagate demand through additional relations.

```text
query bindings
    -> demand facts
    -> restricted rule instances
    -> bottom-up evaluation
    -> requested tuples
```

Tabling moves Prolog toward fixpoint materialization. Magic sets move Datalog
toward goal-directed evaluation. The engines retain different state models:

| Technique | Demand unit | Stored unit | Completion |
| --- | --- | --- | --- |
| SLD | goal | environments and choice points | search exhausted or answer found |
| SLG | tabled call pattern | calls, answers, suspended consumers | table component completes |
| Datalog | whole relation program | indexed tuples and deltas | no new tuples |
| magic-set Datalog | query binding pattern | demand and result relations | no new demanded tuples |

<!-- end_slide -->

# The compressed implementation map

```text
WAM / SLD
    reversible substitutions + control stacks
    proof search demanded by a goal

SLG
    tabled calls + answer propagation + suspension
    goal-directed fixpoint

RAM / semi-naive Datalog
    indexed relations + delta rounds
    least-model construction

CHR
    constraint multiset + committed rewrite rules
    local propagation to quiescence

egglog
    relational facts + e-classes + rewrite saturation
    equality-aware fixpoint
```

The main design axes are:

1. Goal demand versus program saturation.
2. Finite tuples versus recursive terms.
3. Ordered answers versus set or lattice aggregation.
4. Reversible environments versus monotone stores.
5. Search failure versus absence from a completed relation.
6. Stratified negation versus goal-local negation as failure.

