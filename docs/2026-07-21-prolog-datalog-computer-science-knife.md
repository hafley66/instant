---
title: The Computer-Science Knife Between Prolog and Datalog
author: Chris Hafley
---

# Prolog and Datalog

## Where the machines actually separate

```text
Prolog computes proofs for a goal.
Datalog computes a model for a program.
```

Both can use Horn clauses and unification. Their runtimes organize work around different objects.

<!-- end_slide -->

# One logical program

```prolog
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
```

```text
Prolog:  Which substitutions prove ancestor(alice, Who)?
Datalog: Which ancestor tuples belong to the least model?
```

<!-- end_slide -->

# SWI-Prolog begins with a goal

```prolog
?- ancestor(alice, Who).
```

```text
ancestor(alice, Who)
    |
    +-> parent(alice, Who)
    |
    +-> parent(alice, Z), ancestor(Z, Who)
```

Failure restores bindings and resumes another alternative.

<!-- end_slide -->

# SWI-Prolog machine state

Classic Prolog execution uses the Warren Abstract Machine.

```text
current goals
variable bindings
environment frames
heap terms
choice points
trail of reversible bindings
continuation addresses
```

```text
unify -> execute -> choose -> bind -> fail -> untrail -> resume
```

<!-- end_slide -->

# Soufflé begins with relations

```dl
ancestor(x, y) :- parent(x, y).
ancestor(x, y) :- parent(x, z), ancestor(z, y).
```

```text
ancestor[0] = parent

ancestor[n+1] =
    ancestor[n]
    union join(parent, ancestor[n])
```

Evaluation stops when an iteration adds no tuples.

<!-- end_slide -->

# Semi-naive evaluation

```text
delta[0] = parent

delta[n+1] =
    join(parent, delta[n])
    minus ancestor[n]
```

Soufflé lowers rules into relational algebra operations over indexes, delta relations, and strongly connected rule components.

<!-- end_slide -->

# Soufflé machine state

```text
relations
tuple indexes
delta relations
join plans
rule dependency components
fixpoint iteration state
```

```text
facts -> indexes -> joins -> deltas -> SCC rounds -> fixed model
```

<!-- end_slide -->

# The semantic knife

```text
Prolog
program + goal
    -> ordered stream of substitutions

Datalog
program + facts
    -> least fixed-point database
```

For a finite, pure, function-free Horn program, both can produce the same logical answers.

<!-- end_slide -->

# Answers versus tuples

Prolog presents substitutions:

```prolog
Who = bob ;
Who = carol ;
Who = dana.
```

Datalog materializes tuples:

```text
ancestor(alice, bob)
ancestor(alice, carol)
ancestor(alice, dana)
```

Prolog may preserve proof order and repeated proof paths. Datalog normally deduplicates tuples.

<!-- end_slide -->

# The sharp boundary: the term universe

```prolog
nat(0).
nat(s(N)) :- nat(N).
```

The Herbrand universe is infinite:

```text
0
s(0)
s(s(0))
s(s(s(0)))
...
```

<!-- end_slide -->

# Goal-directed construction

Top-down execution can prove a bounded goal:

```prolog
?- nat(s(s(0))).
true.
```

Bottom-up saturation attempts to derive:

```text
nat(0)
nat(s(0))
nat(s(s(0)))
...
```

No finite fixpoint exists.

<!-- end_slide -->

# Finiteness is an implementation boundary

```text
arbitrary constructors
+ bottom-up saturation
= potentially infinite materialization
```

Datalog commonly guarantees a finite active domain by restricting function symbols and requiring rule variables to be range-restricted.

<!-- end_slide -->

# Multi-directional predicates

```prolog
append([a], [b], X).
append(X, Y, [a, b]).
append(X, [b], [a, b]).
```

Unification solves for different unknowns.

The complete relation over arbitrary lists is infinite. Goal-directed execution explores the requested portion.

<!-- end_slide -->

# Failure as control flow

```prolog
p(X) :-
    candidate(X),
    check(X).
```

When `check(X)` fails:

```text
undo bindings
restore a choice point
try another candidate
```

A failed Datalog join simply contributes no output tuple.

<!-- end_slide -->

# Negation

Common Prolog uses goal-directed negation as failure:

```prolog
not(P) :- call(P), !, fail.
not(_).
```

Stratified Datalog evaluates a completed lower relation first:

```dl
orphan(x) :- person(x), !has_parent(x).
```

The upper stratum computes a set difference.

<!-- end_slide -->

# Cut is one visible difference

```prolog
choose(X) :- preferred(X), !.
choose(X) :- fallback(X).
```

Cut commits the search machine to choices already made.

```text
goal-directed proof search
reversible substitutions
ordered alternatives
recursive term construction
partially instantiated queries
```

<!-- end_slide -->

# Tabling narrows the gap

```prolog
:- table ancestor/2.
```

```text
call table:
    ancestor(alice, _)

answer table:
    bob
    carol
    dana
```

Recursive calls consume and extend tables until no new answers appear.

<!-- end_slide -->

# SLG resolution

```text
goal
  -> tabled calls
  -> answer propagation
  -> suspended continuations
  -> completion when no answers remain
```

```text
SLG Prolog:
goal-directed fixed point over calls and substitutions

Datalog:
program-directed fixed point over relations and tuples
```

<!-- end_slide -->

# Magic sets move the other direction

Magic-set transformation rewrites Datalog to propagate bindings from a query.

```text
query bindings
    -> demand relations
    -> restricted bottom-up derivation
    -> requested answers
```

```text
tabling makes Prolog more fixpoint-shaped
magic sets make Datalog more goal-shaped
```

<!-- end_slide -->

# Atoms and strings

The representation difference is shallow:

```prolog
snapshot
```

can be stored as an interned Sprefa text symbol.

Compound terms carry the deeper structure:

```prolog
stream(snapshot_type)
union([snapshot(snapshot_type), update(update_type)])
```

<!-- end_slide -->

# Terms as relational data

Compound terms can be hash-consed:

```text
term(term_id, constructor, arity)
term_arg(term_id, position, child_term_id)
```

```text
Term:
union([snapshot(Snapshot), update(Update)])

Relations:
union_variant(U, "snapshot", Snapshot)
union_variant(U, "update", Update)
```

<!-- end_slide -->

# DCGs are relation syntax

```prolog
model(M) -->
    [model],
    identifier(Name),
    body(Fields),
    { M = model(Name, Fields) }.
```

Desugared:

```prolog
model(Start, End, M) :-
    token(Start, Mid1, model),
    identifier(Mid1, Mid2, Name),
    body(Mid2, End, Fields),
    M = model(Name, Fields).
```

<!-- end_slide -->

# Bottom-up DCG execution

Token positions bound the parsing domain.

```text
nonterminal(start, end, syntax_node)
```

A bottom-up fixpoint stores recognized spans like a chart parser. Ambiguity appears as multiple relation rows.

```text
tokens -> terminal spans -> nonterminal spans -> parse roots
```

<!-- end_slide -->

# Sprefa remains Datalog-shaped with

```text
interned atoms
finite compound values
typed constructor columns
pattern matching over constructors
DCGs lowered into span relations
stratified negation
semi-naive fixpoints
```

These extend the value domain and authoring language while preserving bottom-up model construction.

<!-- end_slide -->

# Sprefa crosses toward Prolog with

```text
arbitrary recursive term construction
partially instantiated term queries
goal-directed predicate invocation
ordered answer enumeration
reversible bindings
backtracking alternatives
cut or committed choice
meta-call over predicate terms
```

These require a search or tabled-goal machine in addition to tuple closure.

<!-- end_slide -->

# A useful hybrid

```text
Sprefa relations and semi-naive evaluation
    + hash-consed constructor terms
    + first-order unification
    + DCG lowering
    + demand propagation
    + memoized calls
    + answer fixpoints
```

This approaches SLG resolution while retaining explicit relations, incrementality, generation sinks, and convergent auto zones.

<!-- end_slide -->

# The knife, compressed

```text
WAM / SLD
    control stack + reversible substitutions
    computes proofs demanded by a goal

RAM / semi-naive Datalog
    indexes + delta relations
    computes the least model of a program

SLG
    tabled calls + answer propagation
    computes a goal-directed fixpoint
```

The central choices are demand, term finiteness, answer ordering, and whether the runtime stores reversible environments or monotone relations.
