---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use an Engine-agnostic Intermediate Representation

## Context and Problem Statement

BPMNscript transforms DSL source code into BPMN 2.0 XML with engine-specific extensions (currently Operaton).
Should the transformation pipeline include an intermediate representation (IR) between the DSL AST and the BPMN XML output?

## Decision Drivers

- Decoupling DSL syntax from BPMN serialization simplifies both grammar design and code generation
- An engine-neutral IR allows future engine backends (Camunda 8, Flowable) without changing the DSL
- The reverse transformation (BPMN XML to DSL) benefits from a shared IR

## Considered Options

- Engine-agnostic IR between AST and BPMN XML
- Direct AST-to-XML transformation (no IR)

## Decision Outcome

Chosen option: "Engine-agnostic IR between AST and BPMN XML", because it decouples syntax design from serialization concerns and provides a clean extension point for future engine backends.

### Consequences

- Good, because DSL grammar changes do not cascade into BPMN serialization logic
- Good, because engine-specific extensions (Operaton namespace attributes) are applied at the IR-to-XML boundary, not embedded in the grammar
- Good, because the reverse transformation (BPMN XML to DSL) shares the same IR
- Bad, because an additional layer adds implementation effort and a mapping surface to maintain
