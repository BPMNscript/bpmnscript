---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Diagram interchange: auto-layout and the sub-process expansion hint

## Context and Problem Statement

BPMN 2.0 XML carries Diagram Interchange (DI) data that fixes the graphical layout of process elements: positions, dimensions and edge waypoints.
A textual DSL has no coordinate system of its own, so it has to settle what happens to DI on export from the DSL and on import of an existing diagram.
A nested container is part of the same question, since an embedded sub-process holds a plane of its own.

## Decision Drivers

- A textual DSL has no inherent coordinate system for graphical layout.
- Preserving original DI data through a text-based round-trip is impractical.
- Generated BPMN XML must be renderable by standard BPMN tools.
- No layout computation of our own, since a bespoke box-and-offset algorithm would duplicate what a layout library already does.
- DI is presentation only, so nothing about it may touch the semantic element tree or its ids.
- A process without any sub-process must keep producing byte-identical output, which is the path the export pipeline is tested and deployed against.

## Considered Options

- Auto-layout the whole diagram on export, discard DI on import, and pre-seed a minimal `isExpanded` shape hint per sub-process so the library expands nested containers
- Preserve DI data in a side channel, as annotations in the source or as a separate file, impractical for a text-based round-trip
- Include layout hints in the DSL syntax, which would put graphical coordinates into a language meant to describe process semantics only
- Accept the collapsed sub-process rendering and post-process the output to strip the misplaced child shapes, which still hides an embedded sub-process's children from a viewer and is more code than the hint for a worse result
- Compute sub-process bounds and child placement manually, bypassing the layout library for nested containers, which reintroduces the custom layout code this decision exists to avoid for one case and is an open-ended burden to keep visually consistent with the library

## Decision Outcome

Chosen option: auto-layout on export with a pre-seeded expansion hint, and DI discarded on import, because a textual DSL has no meaningful way to represent or preserve graphical coordinates, and `bpmn-auto-layout` (the bpmn.io layout library) produces adequate diagrams from the process content alone.

`irToXml` computes no coordinates.
It serializes DI-less BPMN XML and hands it to `bpmn-auto-layout`, which lays out every element and injects the `bpmndi:` diagram-interchange data.

Fed DI-less XML containing a `bpmn:subProcess`, the library does not throw, and it does not produce a degraded-but-sane result either: it renders the sub-process as a collapsed box and scatters shapes for its nested children into the root plane, at coordinates that duplicate unrelated top-level elements.
The output parses and validates, so nothing signals the problem, while a viewer opening the generated diagram shows the sub-process's children floating on top of sibling top-level elements instead of nested inside their parent.
The library reads an existing shape's `isExpanded` flag before computing bounds, and simply had nothing to read when no shape pre-existed.
Supplying that one boolean per sub-process is the smallest input that makes it take the branch it already has for expanded containers.

Before calling `moddle.toXML`, `irToXml` walks the built moddle tree for every `bpmn:SubProcess` element at any nesting depth.
Only when at least one exists, it attaches a `bpmndi:BPMNDiagram` holding a `bpmndi:BPMNPlane` rooted at the process, which in turn holds one `bpmndi:BPMNShape` per sub-process, each carrying `isExpanded="true"` and a `bpmnElement` reference to its sub-process.
No `dc:Bounds` are supplied, since the library recomputes and discards any bounds on a pre-existing shape and derives correct ones from the expanded layout.
What it does need, and what the shape carries for no other reason, is an `id`: it locates a pre-existing shape by looking it up in its own id-keyed element index while parsing the hinted XML, so a shape without one is invisible to it even though nothing in the final output ever references that id back.
`bpmn-auto-layout` then discards every pre-existing diagram (`this.diagram.diagrams = []`) after reading the `isExpanded` flags off it and regenerates the diagram it actually serializes, so the hint is a one-shot instruction rather than persisted diagram data.

### Consequences

- Good, because the DSL syntax stays focused on process semantics and carries no coordinates.
- Good, because the layout library produces consistent, readable diagrams and computes every bound and waypoint in the final document, with no coordinate math and no added dependency of ours.
- Good, because a process without a sub-process attaches no hint at all, so its output is byte-for-byte unchanged.
- Bad, because manually arranged layouts in imported BPMN files are lost after a round-trip.
- Bad, because the hint's correctness is pinned to one specific behavior of the installed `bpmn-auto-layout` version, namely reading `isExpanded` off an id-keyed pre-existing shape.
  A library upgrade that changes how it detects expansion could regress nested layout without any XML-validity signal.
- Neutral, because users who need precise layout control can adjust the generated BPMN in a graphical editor after export.

### Confirmation

A regression tripwire in `ir-to-xml.test.ts` builds an IR whose sub-process has two or more children, runs it through the real `irToXml` with no mocks and the actual installed `bpmn-auto-layout`, and asserts every nested child's `bpmndi:BPMNShape` bounds fall strictly inside its parent sub-process's shape bounds.
The same suite pins two-level nesting (inner sub-process inside outer, inner children inside inner), exactly one `bpmndi:BPMNDiagram` in the final output rather than a duplicate of the hint, and that a sub-process-free process's output stays byte-identical to the frozen golden.

## More Information

The hint is built by `buildSubProcessExpansionHint` and `collectSubProcessElements` in `packages/transform/src/ir-to-xml.ts`, called from `irToXml` right before serialization.
The IR itself carries no layout information (ADR-0007), since the hint is derived purely from the moddle tree built for export and never stored.

When `bpmn-auto-layout`'s grid solver throws on a graph it cannot place, `irToXml` raises `LayoutError`.
It carries the document serialized just before the layout call, with no `bpmndi:` diagram.
The CLI and the extension catch it, write that diagram-less document, and warn the user instead of losing the output.
The engine deploys it unchanged: `BpmnParse.parseDiagramInterchangeElements` reads a diagram only when the document's `BPMNDiagram` list is non-empty, and a document with none skips diagram parsing and deploys on its process content alone.

The layout as it stands has three known defects, each measured on the current tree.
The measurement walks every flow node for a shape, every sequence flow for an edge, and every edge segment for an activity shape it crosses that is neither its source nor its target.
First, a `goto` edge into a sub-process is routed across the sub-process's own children instead of around them.
The example `order-handling`'s `Flow_MarkAutoApproved_Payment` crosses both the `Payment` sub-process's start event and its first task.
The golden `boundary-events`' `Flow_MarkAddressVerified_PackGoods` crosses the `PackGoods` sub-process's start event and its first task the same way.

Second, the spread of several boundary events on one host scales with the host's width rather than with the events' own.
The library places the `i`-th of `n` attachers at `host.x + (i + 1) * host.width / (n + 1) - 18`, all on the host's lower edge.
Two events on a 100 px task therefore sit 33 px apart at their centers while each is 36 px wide.
In the golden `boundary-events`, the two events on `CheckAddress` (x 625 to 725) span x 640.3 to 676.3 and x 673.7 to 709.7, overlapping by 2.7 px.
Two events overlap on any host narrower than 108 px, three times an event's width, and every further event narrows the spacing again; the two on the 850 px wide `PackGoods` sub-process land 283 px apart and clear each other.

Third, a guard clause such as `if (chargeDeclined) { end BookingAbandoned }` keeps the join that only its default flow reaches (ADR-0031).
The layouter puts the end event in the cell between the split and that join on the same row, so the default edge runs straight through it.
The example `booking-attempt`'s `Flow_Gateway_booking-attempt_1_2_split_default` crosses `BookingAbandoned` this way, and the goldens `event-handlers` (`PaymentFailed`) and `transactions` (`BookingAbandoned`) carry the same shape.
A border-termination pass for the first defect and a boundary-spread pass for the second are both considered options, not committed work; the third goes away with the join elision ADR-0031 defers.
