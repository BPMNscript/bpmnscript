---
status: accepted
date: 2026-06-30
decision-makers: Marlon Kranz, Oliver Kopp
---

# Target users without BPMN knowledge, and minimize boilerplate

## Context and Problem Statement

ADR-0011 gave BPMNscript a structured, code-like surface aimed at developers who prefer working in code.
It left two questions open: how much BPMN literacy the language may assume, and how much required syntax is acceptable.
Keywords, settings, and event declarations could still presuppose familiarity with BPMN's element types and vocabulary, and the grammar could still demand explicit text where the compiler could supply a default.
A third question came with a proposal to push the boilerplate rule past the model: write the body of a `JavaDelegate`'s `execute` method directly in the `.bpmnscript` file, generate the complete Java class from it, scaffold the surrounding Operaton application (build configuration, Spring Boot wiring, resources), and generate tests for the result.

How much BPMN knowledge may the language assume, how much required syntax is acceptable, and does the host application's boilerplate belong to the language too?

Decided in the supervision meeting of 2026-06-30.

## Decision Drivers

- BPMN-literate users already have a well-supported option: the graphical modeler.
  The textual language is motivated by the other population, for whom BPMN vocabulary is a barrier rather than a help.
- Required syntax that carries no process information raises the entry barrier without paying for itself.
- ADR-0011's structured constructs already hide gateway mechanics behind `if`/`while`/`parallel`.
  Without an explicit audience decision, future grammar work has no tiebreaker between "closer to BPMN" and "simpler for newcomers".
- Bidirectional conversion between DSL and BPMN XML is a core property of the tool, so text the target format has no slot for cannot enter the surface.
- ADR-0007 keeps the IR a clean graph of process semantics, not a store for host-language code.

## Considered Options

- Assume BPMN literacy: mirror BPMN terminology and structure, keeping the text close to the XML it compiles to
- Assume general programming literacy but no BPMN knowledge, and minimize required syntax
- Go further and take the host application's boilerplate too: embed Java method bodies in the DSL and generate the delegate classes, a complete Operaton application, and tests

## Decision Outcome

Chosen option: "Assume general programming literacy but no BPMN knowledge, and minimize required syntax".
Concretely, two rules bind future grammar decisions:

1. No BPMN prerequisite.
   Reading or writing a `.bpmnscript` file must not require knowing BPMN.
   Keywords name what the user means (a step a person performs, a step the system performs, a decision), not the BPMN element behind it.
2. Defaults over declarations.
   Whenever the compiler can infer or synthesize a detail, the grammar must not require the user to write it.
   When two designs express the same process, the one with less required text wins.

Implicit sequence flow (ADR-0011) and synthesized structural ids (ADR-0010) already follow both rules; this decision makes them binding for what comes next.

The second rule stops at the compiler's output boundary, which is BPMN XML.
`bpmns build` compiles a `.bpmnscript` file to a `.bpmn` file, `bpmns parse` decompiles it back, and delegate classes are hand-written in a separate host application, as in `examples/spring-boot/`.
Embedding a method body would give up the two properties the design rests on: BPMN XML has no representation for Java source, so an embedded body is lost on compile and cannot be recovered on decompile, and carrying it through the IR pierces ADR-0007's boundary.
It would also change what deployment means.
BPMN XML alone hot-deploys through a single REST call (`POST /engine-rest/deployment/create`), while a Java class has to be on the engine's classpath, so every change to an embedded body forces a rebuild and restart of the host application and the deployment unit becomes the application rather than the model.
The generated scaffold is a long-lived support surface of its own, in dependency versions, upgrade path and build tooling, beyond the thesis time budget.

### Consequences

- Good, because the entry barrier drops: a newcomer can write a running process without first learning BPMN's vocabulary or diagram semantics.
- Good, because grammar discussions get a tiebreaker instead of re-arguing the audience each time.
- Good, because no lossy construct enters the language and the IR stays free of host-language code, so the round-trip guarantees hold for everything the surface admits.
- Good, because a deploy command stays a thin REST client, the mechanics the end-to-end test adapters (`tests/fixtures/adapters/`) already exercise.
- Bad, because hiding BPMN vocabulary makes the DSL-to-XML correspondence less obvious for BPMN-literate readers; documentation has to carry that mapping, and the README glossary is a start.
- Bad, because every default the grammar adopts is a rule the round trip must invert, synthesized on compile and elided on decompile, growing the mapping surface that ADR-0010 normalization already covers for ids.
- Bad, because delegates are written and kept in sync by hand; the `class: "..."` string is not checked against any Java source, so a mismatch surfaces only at engine runtime.
- Bad, because the one-file authoring experience is not available: a process and the code its steps call live in separate files.

## More Information

The engine tuning keys (`asyncBefore`, `asyncAfter`, `exclusive`, `jobPriority`, `retryCycle`) and the listener block are engine-side settings outside the no-BPMN-knowledge promise: they name what Operaton does with a step, not a BPMN element, and a reader who never tunes the engine never writes them.
Generating tests for the compiled `.bpmn` artifact stands on its own: it consumes the compiler's existing output rather than adding Java source to the language, so none of the round-trip or IR concerns apply to it, and it is set aside as possible later work.
