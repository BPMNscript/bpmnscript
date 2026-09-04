---
status: accepted
date: 2026-07-04
decision-makers: Marlon Kranz
---

# Honest BPMN Import: Refuse Unsupported Constructs, Warn on Non-Semantic Drops

## Context and Problem Statement

`xmlToIr`'s docstring stated that silent semantic loss is impossible, but the transform actually dropped several kinds of content without any diagnostic: event definitions on start/end events (timer, message, signal, error, terminate), loop characteristics on tasks (multi-instance and standard loop), whole collaborations (pools and message flows), Operaton/camunda extension attributes beyond `assignee`/`formKey`/`class`, and lanes.
Some of these drops change what the imported process executes; others do not.
The import contract needs to make good on its own claim: what should happen when `xmlToIr` encounters content the IR cannot carry, and should every such case be treated the same way?

## Decision Drivers

- The "no silent semantic loss" claim must hold for content whose absence changes execution semantics.
  A dropped timer or a dropped loop is not a cosmetic loss.
- Not every unrepresentable construct is equally severe.
  Refusing content that causes no semantic loss (an extension attribute, a lane) would make the importer unusable on any file a real modeler exports, since modelers routinely add such content.
- Whatever channel reports non-fatal drops must be impossible to ignore by accident; a warning nobody reads is equivalent to a silent drop.
- Consumers (the CLI, the VS Code extension) need one classification check ("is this an unsupported-construct refusal?") that does not have to enumerate every error subclass by hand as new ones are added.

## Considered Options

- Two-tier contract: refuse (throw) constructs that change execution semantics, warn (return) on constructs that do not
- Refuse everything the IR cannot express, with no warning tier
- Keep the current behavior (drop silently) and only correct the docstring to describe it

## Decision Outcome

Chosen option: "Two-tier contract: refuse constructs that change execution semantics, warn on constructs that do not", because it is the only option consistent with the "no silent semantic loss" claim while remaining usable on real Modeler-exported files, which routinely carry cosmetic extension content that a total-refusal contract would reject outright.

Refused constructs throw a subclass of `UnsupportedConstructError` before any IR is produced, so there is never a partial IR, and the refusals include:

- an event definition of a kind the event's position does not accept -> `UnsupportedEventDefinitionError`
- a repetition the engine refuses to deploy or never dispatches on, one this tool cannot write back unchanged, and any repetition on an event handler -> `UnsupportedLoopCharacteristicsError`
- a collaboration (pools/message flows) -> `UnsupportedCollaborationError`
- an event of a supported kind carrying a shape the surface cannot express, such as an error throw with no code -> `UnsupportedEventFeatureError`
- a call activity naming a resolution shape the surface cannot write back -> `UnsupportedCallActivityError`
- an `operaton:formField` of a type the form surface does not map -> `UnsupportedFormFieldTypeError`
- Operaton extension content the IR's discriminated unions cannot represent, such as a parameter carrying body text and a nested value at once -> `UnsupportedExtensionFormError`
- an unsupported flow-element kind (pre-existing) -> `UnsupportedElementError`
- an unsupported service-task execution form (pre-existing) -> `UnsupportedServiceTaskFormError`

Every refusal shares the abstract base `UnsupportedConstructError`, so a consumer classifies the whole family with a single `instanceof` check while each subclass still carries construct-specific metadata for a tailored message.

Warned constructs are returned in a `warnings: ImportWarning[]` array alongside the IR.
`xmlToIr` now returns `{ ir, warnings }` rather than a bare `BpmnProcess`:

- an Operaton or camunda extension attribute or element whose content the IR does not read.
  The boundary is drawn per owner kind rather than by a list of names, so `operaton:assignee` is data on a user task and a reported drop on a service task.
- lanes
- a `name` on an event handler, a boundary event, a throw, an emit, or an await, since none of those has a label slot in this tool's surface; and a `name` on a start or an end whose id carries a synthesized-id prefix, which no script can spell back, so the statement that would have carried the label is left out whole
- a `bpmn:Error`, `bpmn:Escalation`, `bpmn:Message`, or `bpmn:Signal` root that nothing in the imported process references, except an error root whose declared message the IR keeps regardless
- `bpmn:documentation` on any element
- BPMN content on an element the transform touches that no reader reads: an artifact on a process or a sub-process (a `bpmn:textAnnotation`, its `bpmn:association`, a `bpmn:group`), a `bpmn:ioSpecification`, a `bpmn:property`, a data association, a `bpmn:auditing` or `bpmn:monitoring` block, and a resource assignment such as a `bpmn:potentialOwner`
- a root element other than the process and the error, escalation, message, and signal roots the events resolve against, such as a `bpmn:category`, a `bpmn:dataStore`, a `bpmn:itemDefinition`, or a `bpmn:interface`
- an attribute written without a namespace that BPMN does not declare
- a BPMN-declared attribute the engine itself reads nothing of, an `instantiate="true"` or an `eventGatewayType` other than `Exclusive` on a wait with several branches, so the imported process runs exactly as the source document does.
  Each is reported only where the document set it away from the value it reads back as when nothing is written, which is why an exported gateway carrying `eventGatewayType="Exclusive"` warns about nothing.
- a `default` on a step, which the engine does read: it names the route Operaton takes when no other route out of the step is taken, and this tool carries a fallback on a split alone, so the imported process loses that route and does not run as the source document does.
- `isExecutable="false"` on the process, which imports as an executable process regardless

No element leaves the transform unreported.
Whatever it cannot carry is named by the tag the document spells and by its own id, and attributed to the element it sat on, a construct being reported whole so that a dropped `bpmn:ioSpecification` names itself rather than each data input inside it.
The lane structure goes the same way, reported lane by lane, with anything hung on a lane or a lane set leaving with it.
What is dropped without a warning is the diagram interchange data ADR-0003 settles, and an attribute the transform does not read.
One shape of that is an attribute in a foreign namespace written directly on a mapped BPMN element, which is where an editor parks its own bookkeeping.
The same attribute on an extension child the IR reads is reported, and so is an attribute written in no namespace at all that BPMN does not declare, since no editor writes there.
The other is a BPMN attribute the transform neither reads nor reports, such as a sequence flow's `name`, a process's `processType` or `isClosed`, a `startQuantity`, or the `language` on a condition expression.

Returning `{ ir, warnings }` makes the warnings channel unignorable at the type level: every call site must destructure or explicitly discard `warnings`, so a caller cannot silently drop the diagnostics this decision exists to guarantee.
The alternatives, an optional collector parameter (`xmlToIr(xml, sink?)`) or a second function (`xmlToIrWithWarnings`), leave the channel easy to skip.

The contract covers two hops.
`irToDsl` reports in the same shape, returning `{ source, warnings }` for the reason `xmlToIr` returns `{ ir, warnings }`: a channel a caller can skip is a silent drop.
Its warnings carry the same fields and report what the print hop could not carry into the script.
Some of what they name merely drops, such as a gateway label no statement form can hold.
Some changes what a recompiled document runs, such as a fallback re-derived on an imported fork whose branches all carry conditions and that named none.
Some is printed as the model spells it and draws an error when the source is read back: an `else` beside a branch that runs whatever the conditions do leaves the fallback nothing to take, and the script it prints does not recompile at all.
Every one of them is warned rather than refused, because a refusal has no meaning on this hop: the restructurer is total by ADR-0009 and always produces source.
The reports themselves live in `packages/transform/src/ir-to-dsl.ts`, where `PrintWarningCategory` and the warnings built beside it settle which the print hop makes and what each one costs.
ADR-0025 is the decision that extended this contract to the print hop.

### Consequences

- Good, because every caller (the CLI, the VS Code extension, the round-trip test suite) now surfaces both the refusal and the warning channel instead of only one or neither.
- Good, because the shared `UnsupportedConstructError` base keeps consumer classification to one `instanceof` check as new refusal categories are added.
- Bad, because some warned items on the import hop do bear on what runs, against the boundary this decision draws, among them a dropped `bpmn:potentialOwner`, which changes who may claim a task, a dropped `operaton:field`, which leaves the bound class without a value it was injected with, a dropped `default` on a step, which takes away the route the engine falls back to, and `isExecutable="false"`, which imports as an executable process.
  Refusing any of them would reject files that otherwise import cleanly, and carrying `isExecutable` through would mean an IR field, a serializer path, and a DSL surface for a flag this tool has no use for, so they are reported instead.
- Bad, because every call site of `xmlToIr` had to migrate from `const ir = await xmlToIr(xml)` to `const { ir } = await xmlToIr(xml)`, a one-time, mechanical, but repo-wide edit.
- Bad, because a handful of undeclared `operaton:` extension elements cannot be tied by `bpmn-moddle` to a specific owning element; their warnings are attributed to the process id rather than the precise element.

## More Information

The exact refuse/warn boundary and the `ImportWarning` shape (`elementId`, `category`, `message`) are documented in `packages/transform/src/errors.ts` and `packages/transform/src/xml-to-ir.ts`; a consumer-facing summary is in `packages/transform/README.md`.

Related decisions: ADR-0006 (the shared IR, where `warnings` deliberately lives outside the IR, which stays serializable).
ADR-0007 (the Operaton moddle extension fork, whose declared and undeclared elements determine warning-attribution precision).
ADR-0003 (auto-layout for diagram interchange, the one kind of element this contract drops without a warning).
