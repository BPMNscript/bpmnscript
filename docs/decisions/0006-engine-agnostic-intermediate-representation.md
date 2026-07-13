---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use an Intermediate Representation between the AST and BPMN XML

## Context and Problem Statement

BPMNscript compiles DSL source to BPMN 2.0 XML and decompiles BPMN 2.0 XML back to DSL source. The two directions are not mirror images. The DSL AST is block-structured (`if`, `while`, `parallel`, nested statements); BPMN is a flat graph of flow nodes and sequence flows. Compiling turns blocks into a gateway graph; decompiling recovers block structure from an arbitrary graph.

Should both directions route through a shared intermediate representation (IR), or should each convert directly between the AST and BPMN XML?

## Decision Drivers

- The two transforms are the hardest code in the project: gateway synthesis on the way down, dominator-based restructuring on the way up (ADR-0009, ADR-0010). Both need a graph model to run against, and neither the block-structured AST nor moddle's serialization-bound object model is one.
- A shared model lets the two directions meet in the middle, so the round-trip is one model with four transforms instead of two independent converters. Round-trip idempotence then becomes a property of a single representation.
- Grammar changes should not cascade into serialization logic, and serialization details (namespaces, diagram interchange, Operaton extension attributes) should not leak into the grammar.

## Considered Options

- An IR between the AST and BPMN XML
- Direct AST-to-XML conversion, with moddle's object model standing in for a graph representation

## Decision Outcome

Chosen option: an IR between the AST and BPMN XML.

The IR is a small, statically typed graph: flow elements and sequence flows over a closed set of node kinds. Gateway synthesis (`astToIr`) and structural recovery (`irToDsl`) both operate on it, isolated from Langium's AST and from moddle's dynamically typed, diagram-carrying objects. Because both directions share it, the round-trip is verified against one representation rather than two.

Portability across execution engines is a non-goal. The project targets Operaton (ADR-0007), so the IR is not abstracted for other engines. It models the semantics Operaton executes — executable processes, Java-class service tasks, process variables — under field names that carry no vendor prefix. Attributes that vary only at serialization, such as `operaton:historyTimeToLive`, are attached at the IR-to-XML boundary and are not stored in the IR.

### Consequences

- Good, because the restructuring and gateway-synthesis algorithms work on a clean typed graph, which keeps the project's most complex code independent of the XML library.
- Good, because grammar changes stay out of serialization logic, and Operaton extension attributes are applied at the IR-to-XML boundary rather than embedded in the grammar.
- Good, because both directions share one model, so round-trip idempotence is tested against a single representation.
- Bad, because the extra layer is a mapping surface: every element the DSL supports must be modeled in the IR and mapped on both sides.
