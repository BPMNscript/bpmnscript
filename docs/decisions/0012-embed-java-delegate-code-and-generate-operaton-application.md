---
status: rejected
date: 2026-07-04
decision-makers: Marlon Kranz
consulted: thesis supervisor
---

# Embed Java Delegate Code and Generate the Operaton Application

## Context and Problem Statement

The thesis supervisor proposed a deploy feature: write the body of a `JavaDelegate`'s
`execute` method directly in the `.bpmnscript` file, generate the complete Java class from
it, scaffold the surrounding Operaton application (build configuration, Spring Boot wiring,
resources), and generate tests for the result.

Today the toolchain stops at BPMN XML. `bpmns build` compiles a `.bpmnscript` file to a
`.bpmn` file, `bpmns parse` decompiles it back, and `service X { class = "..." }` carries
only a class-name string (emitted as `operaton:class`). Delegate classes are hand-written
in a separate host application, as in `examples/spring-boot/`.

Should the compiler's output boundary move from BPMN XML to a complete, runnable Operaton
application?

## Decision Drivers

- Bidirectional conversion (DSL ↔ BPMN XML) is a core property of the tool. BPMN XML has
  no representation for Java source, so embedded method bodies are lost on compile and
  cannot be recovered on decompile — the target format has no slot for the information.
- ADR-0006 keeps the IR a clean graph of process semantics, not a store for
  host-language code. `JavaDelegate` bodies are Java source; carrying them through
  the IR pierces that boundary.
- "Deploy" changes meaning. BPMN XML alone hot-deploys through a single REST call
  (`POST /engine-rest/deployment/create`), but Java classes must be on the engine's
  classpath: every change to an embedded body forces a rebuild and restart of the host
  application. The deployment unit becomes the application, not the model.
- A generated application scaffold is a long-lived support surface (dependency versions,
  upgrade path, build tooling) that exceeds the thesis time budget.

## Considered Options

- Embed Java method bodies in the DSL and generate delegate classes, a full Operaton
  application, and tests
- Keep BPMN XML as the compilation boundary; delegates remain hand-written in a host
  application

## Decision Outcome

The proposal is rejected; BPMN XML remains the compilation boundary. Embedding Java gives
up the two properties the design rests on — round-trippable conversion and an IR
that models process structure rather than host-language code — and turns deployment
from a one-artifact REST call into an
application build. The scaffold's maintenance cost alone puts it outside the thesis scope.

### Consequences

- Good, because the existing round-trip guarantees are unchanged; no lossy construct
  enters the language.
- Good, because the DSL and IR stay free of host-language code per ADR-0006.
- Good, because a future deploy command stays a thin REST client — the mechanics the E2E
  test adapters (`tests/fixtures/adapters/`) already exercise.
- Bad, because delegates are written and kept in sync by hand; the `class = "..."` string
  is not checked against any Java source, so a mismatch surfaces only at engine runtime.
- Bad, because the one-file authoring experience the proposal aimed for is not available.

## More Information

One part of the proposal stands on its own: generating tests for the compiled `.bpmn`
artifact. Test generation consumes the compiler's existing output rather than adding Java
source to the language, so none of the round-trip or IR concerns above apply. It is set
aside as possible later work, independent of this decision.
