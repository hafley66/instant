# The Logic Programming Families

This book maps the related language and runtime families around Prolog,
Datalog, relational programming, constraint programming, functional logic,
typed logic, parser DSLs, equality saturation, and incremental dataflow.

The central implementation question is where a system places computation:

- proof search over goals and substitutions;
- least-model construction over relations;
- tabled answer propagation;
- constraint-store propagation;
- term rewriting and congruence closure;
- monotone functions over lattices;
- grammar recognition over token spans.

## Reading order

1. [Foundations and the implementation knife](0_foundations.md)
2. [The Prolog family](1_prolog_family.md)
3. [Datalog and the hybrid systems](2_datalog_and_hybrids.md)
4. [Parser machinery and lattices](3_parsers_and_lattices.md)
5. [Capability matrix and the Sprefa design space](4_matrix_and_sprefa.md)

Every chapter is readable as ordinary Markdown. Major sections use Presenterm
slide boundaries:

```sh
presenterm book/the-log-families/0_foundations.md
```

## Primary references

- [SWI-Prolog](https://www.swi-prolog.org/)
- [XSB](https://xsb.sourceforge.net/)
- [Mercury](https://mercurylang.org/)
- [Picat](https://picat-lang.org/)
- [Teyjus λProlog](https://teyjus.cs.umn.edu/)
- [miniKanren](https://minikanren.org/)
- [Logtalk](https://logtalk.org/)
- [Soufflé](https://souffle-lang.github.io/)
- [Flix](https://flix.dev/)
- [Formulog](https://github.com/HarvardPL/formulog)
- [egglog](https://github.com/egraphs-good/egglog)
- [Datafun paper](https://doi.org/10.1145/3022670.2951948)
- [Dyna paper](https://aclanthology.org/P04-3032/)
- [Galois DaeDaLus](https://www.galois.com/project/daedalus)
- [Berkeley Dedalus](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-173.html)

