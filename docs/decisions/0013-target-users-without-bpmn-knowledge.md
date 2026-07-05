---
status: accepted
date: 2026-06-30
decision-makers: Marlon Kranz, thesis supervisor
---

# Target Users Without BPMN Knowledge and Minimize Boilerplate

## Context and Problem Statement

ADR-0008 gave BPMNscript a structured, code-like surface aimed at developers who prefer
working in code. It left two questions open: how much BPMN literacy the language may
assume, and how much required syntax is acceptable. Keywords, attribute blocks, and event
declarations could still presuppose familiarity with BPMN's element types and vocabulary,
and the grammar could still demand explicit text where the compiler could supply a
default.

How much BPMN knowledge may the language assume, and how much required syntax
(boilerplate) is acceptable?

Decided in the supervision meeting of 2026-06-30.

## Decision Drivers

- BPMN-literate users already have a well-supported option: the graphical modeler. The
  textual language is motivated by the other population, for whom BPMN vocabulary is a
  barrier rather than a help.
- Required syntax that carries no process information raises the entry barrier without
  paying for itself.
- ADR-0008's structured constructs already hide gateway mechanics behind
  `if`/`while`/`parallel`; without an explicit audience decision, future grammar work has
  no tiebreaker between "closer to BPMN" and "simpler for newcomers".

## Considered Options

- Assume BPMN literacy: mirror BPMN terminology and structure, keeping the text close to
  the XML it compiles to
- Assume general programming literacy but no BPMN knowledge, and minimize required syntax

## Decision Outcome

Chosen option: "Assume general programming literacy but no BPMN knowledge, and minimize
required syntax". Concretely, two rules bind future grammar decisions:

1. **No BPMN prerequisite.** Reading or writing a `.bpmnscript` file must not require
   knowing BPMN. Keywords name what the user means (a step a person performs, a step the
   system performs, a decision), not the BPMN element behind it.
2. **Defaults over declarations.** Whenever the compiler can infer or synthesize a
   detail, the grammar must not require the user to write it. When two designs express
   the same process, the one with less required text wins.

Implicit sequence flow (ADR-0008) and synthesized structural ids (ADR-0010) already
follow both rules; this decision makes them binding for what comes next.

### Consequences

- Good, because the entry barrier drops: a newcomer can write a running process without
  first learning BPMN's vocabulary or diagram semantics.
- Good, because grammar discussions get a tiebreaker instead of re-arguing the audience
  each time.
- Bad, because hiding BPMN vocabulary makes the DSL-to-XML correspondence less obvious
  for BPMN-literate readers; documentation has to carry that mapping (the README glossary
  is a start).
- Bad, because every default the grammar adopts is a rule the round trip must invert —
  synthesized on compile, elided on decompile — growing the mapping surface that ADR-0010
  normalization already covers for ids.

## More Information

Related decisions: ADR-0008 (structured, code-like grammar) settled the surface shape;
ADR-0010 (deterministic structural ids) is the existing model for how a compiler-supplied
default stays round-trippable.
