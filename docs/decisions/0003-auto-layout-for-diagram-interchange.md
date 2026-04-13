---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use Auto-layout for Diagram Interchange Data

## Context and Problem Statement

BPMN 2.0 XML includes Diagram Interchange (DI) data that specifies the graphical layout of process elements (positions, dimensions, edge waypoints).
How should BPMNscript handle DI data during DSL-to-XML export and XML-to-DSL import?

## Decision Drivers

* A textual DSL has no inherent coordinate system for graphical layout
* Preserving original DI data through a text-based round-trip is impractical
* Generated BPMN XML must be renderable by standard BPMN tools

## Considered Options

* Auto-layout on export, discard DI on import
* Preserve DI data in a side-channel (annotations or separate file)
* Include layout hints in the DSL syntax

## Decision Outcome

Chosen option: "Auto-layout on export, discard DI on import", because a textual DSL has no meaningful way to represent or preserve graphical coordinates, and auto-layout produces adequate results for generated BPMN XML.

### Consequences

* Good, because the DSL syntax remains clean and focused on process semantics
* Good, because auto-layout libraries (such as `elkjs`) produce consistent, readable diagrams
* Bad, because manually arranged layouts in imported BPMN files are lost after a round-trip
* Neutral, because users who need precise layout control can adjust the generated BPMN in a graphical editor after export
