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

- A textual DSL has no inherent coordinate system for graphical layout
- Preserving original DI data through a text-based round-trip is impractical
- Generated BPMN XML must be renderable by standard BPMN tools

## Considered Options

- Auto-layout on export, discard DI on import
- Preserve DI data in a side-channel (annotations or separate file)
- Include layout hints in the DSL syntax

## Decision Outcome

Chosen option: "Auto-layout on export, discard DI on import", because a textual DSL has no meaningful way to represent or preserve graphical coordinates, and auto-layout produces adequate results for generated BPMN XML.

### Consequences

- Good, because the DSL syntax remains clean and focused on process semantics
- Good, because `bpmn-auto-layout` (the bpmn.io layout library) produces consistent, readable diagrams
- Bad, because manually arranged layouts in imported BPMN files are lost after a round-trip
- Neutral, because users who need precise layout control can adjust the generated BPMN in a graphical editor after export

## More Information

When `bpmn-auto-layout`'s grid solver throws on a graph it cannot place, `irToXml` raises `LayoutError`.
It carries the document serialized just before the layout call, with no `bpmndi:` diagram.
The CLI and the extension catch it, write that diagram-less document, and warn the user instead of losing the output.
The engine deploys it unchanged: `BpmnParse.parseDiagramInterchangeElements` reads a diagram only when the document's `BPMNDiagram` list is non-empty.
A document with none skips diagram parsing and deploys on its process content alone.

The layout as it stands has two known defects, each measured on the current tree.
The measurement walks every flow node for a shape, every sequence flow for an edge, and every edge segment for an activity shape it crosses that is neither its source nor its target.
First, a `goto` edge into a sub-process is routed across the sub-process's own children instead of around them.
The example `order-handling`'s `Flow_MarkAutoApproved_Payment` crosses both the `Payment` sub-process's start event and its first task.
The golden `boundary-events`' `Flow_MarkAddressVerified_PackGoods` crosses the `PackGoods` sub-process's start event and its first task the same way.

Second, two boundary events on one host are placed along the host's lower edge with no spread of their own.
In the golden `boundary-events`, the two events on `CheckAddress` sit only a few pixels apart on a host narrower than their combined width.
The two on `PackGoods` are both centered on the host's bottom edge with no vertical offset between them.
A border-termination pass for the first defect and a boundary-spread pass for the second are both considered options, not committed work.
