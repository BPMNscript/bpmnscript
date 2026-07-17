---
status: accepted
date: 2026-07-17
decision-makers: Marlon Kranz
---

# Author a Diagram-Interchange Expansion Hint for Sub-processes

## Context and Problem Statement

ADR-0003 established that `irToXml` never computes its own coordinates: it serializes
DI-less BPMN XML and hands it to `bpmn-auto-layout`, which lays out every element and
injects the `bpmndi:` diagram-interchange data. That decision assumed a flat process —
one plane, no nested containers.

Embedded sub-processes break the assumption. Fed DI-less XML containing a
`bpmn:subProcess`, the installed `bpmn-auto-layout` does not throw, but it also does not
produce a degraded-but-sane result: it renders the sub-process as a collapsed box and
scatters shapes for its nested children into the *root* plane, at coordinates that
duplicate unrelated top-level elements. The output parses and validates, so nothing
signals the problem — a viewer opening the generated diagram would show the sub-process's
children floating on top of sibling top-level elements instead of nested inside their
parent. How should `irToXml` produce a correctly laid-out diagram for a process that
contains a sub-process, without taking on any layout computation of its own?

## Decision Drivers

- ADR-0003's no-custom-layout-code stance should hold for sub-processes too — introducing
  a bespoke box-and-offset algorithm here would duplicate what `bpmn-auto-layout` already
  does correctly once it is told to expand.
- The fix must not touch the semantic element tree or its ids — DI is presentation only.
- A process without any sub-process must keep producing byte-identical output; this is
  the golden path the export pipeline is tested and deployed against.

## Considered Options

- Pre-seed a minimal `isExpanded` shape hint per sub-process before layout
- Accept the collapsed rendering and post-process the output to strip the misplaced
  child shapes
- Compute sub-process bounds and child placement manually, bypassing `bpmn-auto-layout`
  for nested containers

## Decision Outcome

Chosen option: "Pre-seed a minimal `isExpanded` shape hint per sub-process before
layout", because it stays inside `bpmn-auto-layout`'s own contract — the library already
reads an existing shape's `isExpanded` flag before computing bounds; it simply had
nothing to read when none was pre-existing. Supplying that one boolean per sub-process is
the smallest input that makes the library take the branch it already has for expanded
containers.

Before calling `moddle.toXML`, `irToXml` walks the built moddle tree for every
`bpmn:SubProcess` element, at any nesting depth, and — only when at least one exists —
attaches a `bpmndi:BPMNDiagram` → `bpmndi:BPMNPlane` (rooted at the process) →
one `bpmndi:BPMNShape` per sub-process, each carrying `isExpanded="true"` and a
`bpmnElement` reference to its sub-process. No `dc:Bounds` are supplied: the library
recomputes and discards any bounds on a pre-existing shape, computing correct ones from
the expanded layout instead. What the library does need, and what the shape carries for
no other reason, is an `id` — it locates a pre-existing shape by looking it up in its own
id-keyed element index while parsing the DI-less-but-hinted XML, so a shape without one is
invisible to it even though nothing in the final output ever references that id back.

`bpmn-auto-layout` fully replaces this hint during layout: it discards every pre-existing
diagram (`this.diagram.diagrams = []`) after reading the `isExpanded` flags off it, then
regenerates the diagram it actually serializes. The hint therefore never survives into the
output as such — it is a one-shot instruction, not persisted diagram data.

### Consequences

- Good, because the change stays inside `irToXml`'s existing DI-generation call and adds
  no dependency, no coordinate math, and no custom layout logic — the library still
  produces every bound and waypoint in the final document.
- Good, because a process without a sub-process attaches no hint at all, so its output is
  byte-for-byte unchanged.
- Bad, because the hint's correctness is pinned to one specific behavior of the installed
  `bpmn-auto-layout` version (reading `isExpanded` off an id-keyed pre-existing shape) —
  a library upgrade that changes how it detects expansion could silently regress nested
  layout without any XML-validity signal.

### Confirmation

A regression tripwire in `ir-to-xml.test.ts` builds an IR whose sub-process has two or
more children, runs it through the real `irToXml` (no mocks — the actual installed
`bpmn-auto-layout`), and asserts every nested child's `bpmndi:BPMNShape` bounds fall
strictly inside its parent sub-process's shape bounds. The same test suite also pins:
two-level nesting (inner sub-process inside outer, inner children inside inner), exactly
one `bpmndi:BPMNDiagram` in the final output (the library's regenerated diagram, not a
duplicate of the hint), and that a sub-process-free process's output stays byte-identical
to the frozen golden.

## Pros and Cons of the Options

### Pre-seed a minimal `isExpanded` shape hint per sub-process

- Good, because it is a handful of lines that reuse a code path the layout library
  already has.
- Good, because it degrades to a no-op for sub-process-free processes.
- Neutral, because it depends on empirically observed library internals rather than a
  documented public contract for this exact scenario.

### Accept the collapsed rendering and post-process the output to strip misplaced shapes

- Bad, because a collapsed sub-process still loses the point of an embedded sub-process
  in a viewer — the reader cannot see its children without manually expanding and
  re-laying-out the box themselves.
- Bad, because stripping the scattered child shapes without breaking id references
  between the semantic tree and the DI is more code than the chosen option, for a worse
  result.

### Compute sub-process bounds and child placement manually

- Bad, because it reintroduces exactly the custom layout code ADR-0003 exists to avoid,
  for one specific case, while the rest of the diagram still depends on the library.
- Bad, because keeping a hand-rolled nested-box algorithm visually consistent with
  `bpmn-auto-layout`'s own spacing and sizing conventions is an ongoing maintenance
  burden with no natural termination.

## More Information

Implemented in `packages/transform/src/ir-to-xml.ts`
(`buildSubProcessExpansionHint`/`collectSubProcessElements`), called from `irToXml`
right before serialization. Related: ADR-0003 (auto-layout owns all DI generation; this
decision extends rather than revisits that choice) and ADR-0006 (the IR itself carries no
layout information — the hint is derived purely from the moddle tree built for export,
never stored).
