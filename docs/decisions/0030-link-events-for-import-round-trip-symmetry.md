---
status: accepted
date: 2026-09-12
decision-makers: Marlon Kranz
---

# Link events for import round-trip symmetry

## Context and Problem Statement

BPMNscript's `await` trigger scope covers message, timer, signal, and conditional, and leaves link out: BPMN's off-page connector for splitting one diagram across pages, a problem a single `.bpmnscript` file never has, since `goto` already names a jump inside one textual source.
That choice holds for authoring, but it says nothing about import.
A modeller's existing document can carry a link pair, and the importer refuses `bpmn:linkEventDefinition` by name on both the intermediate throw and the intermediate catch, so such a document does not import at all.
Reading a link pair as a `goto` would not fix this under the honest import contract (ADR-0012), which lets the importer warn on a drop that changes nothing the engine runs but never lets it rewrite what is on the wire into a shape the surface prefers: a `goto` compiles to one sequence flow, so the re-exported XML would hold one edge where the incoming document held two events.
The question this decision settles is whether a construct authoring does not need should exist anyway, for better import coverage of existing models and round-trip symmetry.

## Decision Drivers

- Import coverage of existing models.
  Modelers built on bpmn-js, the Camunda Modeler among them, offer both ends of a link pair, and a document drawn with one is refused today.
- Round-trip symmetry under ADR-0012.
  A construct the importer maps has to re-export as the same XML, and a link pair mapped to a `goto` does not.
- Reuse of what is built.
  ADR-0024's payload surfaces already carry a quoted name for message and signal, and ADR-0023's terminality rule already decides from the printed words whether a statement ends its chain; a fifth catch kind should cost one dispatch case per layer, not a second mechanism.
- The engine's own link semantics.
  Operaton correlates the two ends by name in one table per parsed file, creates no activity for the throw, and rewires flows at deploy time; those facts decide most of the validator rules before this surface gets a say.
- The cost of a second way to spell a jump.
  Two constructs with one meaning is a real price, and this decision has to say what is bought for it.

## Considered Options

- Keep refusing a link definition on import, which adds no grammar rule, no vocabulary row, and no second way to jump, but leaves every diagram using BPMN's own off-page connector unimportable, on a refusal the import contract does not ask for, since the engine deploys and runs a link pair.
- Import a link pair as a `goto`, and never author one, which changes the authoring surface not at all and shows the reader a jump in the form this language already has, but re-exports two events and their definitions as one edge, which round-trip symmetry rules out by construction, and leaves the printer deciding which `goto` edges were links from a fact the IR no longer holds.
- A full surface, `emit link` and a named `await link`, which maps one-to-one in both directions and reuses the payload surface, the required-name check, and the completion snippet message and signal already have, at the price of two constructs for one jump and a name slot on every `await` to make one kind of `await` nameable.

## Decision Outcome

Chosen: the full surface, `emit link ToRetry("Retry")` and `await link AtRetry("Retry")`, because it is the only option under which a document carrying a link pair imports and re-exports as itself.

The verb is `emit` rather than `throw` because `throw` lowers to `bpmn:endEvent` and a link throw is a `bpmn:intermediateThrowEvent`.
`emit link` nonetheless ends its chain, as a `goto` does: `BpmnParse.parseIntermediateThrowEvent` records the throw in `eventLinkSources` and returns before creating an activity, so a flow leaving the throw finds no source and `BpmnParse.parseSequenceFlow` reports it as an invalid source, and the token continues at the catch and nowhere else.
This is the one `emit` whose chain ends; the two printed words `emit link` decide it, never position, so the round-trip argument for terminality read off the text (ADR-0023) still holds.

The link name is quoted text, `link("Retry")`, like a message or signal name.
It keys the engine's own table and declares nothing, so it is not a declared code in the sense ADR-0023 gives error and escalation.
`await` gains the optional name slot `emit` has, legal on every trigger rather than on a link catch alone, because a link catch has to be nameable to keep its id across an import and a link-only slot would need a validator rule with no engine reason behind it.

In the IR both ends carry `{ kind: 'link'; linkName: string }` and no flow runs between them.
The precedent is `BoundaryEvent.attachedToRef`, a node with no incoming flow wired to another by a reference rather than by an edge, not `SubProcess.element`, which is a tag on one node with no graph consequence.
The IR holds no reference field between the two ends because the engine matches them by name alone; an id reference would be a second fact that can drift from the first.
The restructuring analysis wires a link catch to its container's virtual entry the same way it wires a start event and a boundary event, since nothing flows into it: without that edge nothing in its chain has an immediate dominator, and a branch inside a rework chain prints as `goto`s instead of an `if`.
The element `name` attribute is stamped from the link name on both ends: `BpmnParse.parseIntermediateLinkEventCatchBehavior` warns at deploy when the two differ and recommends they match, and modelers render the element name as the label, so stamping it keeps the deployment clean and the diagram readable.

The validator enforces the rules the engine decides, each in the tier the engine's behaviour justifies.
One `await link` per name in the whole file, at any depth, because `eventLinkTargets` is a field of `BpmnParse` that is never cleared between scopes; this is stricter than `goto`, whose targets are container-scoped, and it is the one place link is less expressive than what it duplicates.
Both ends in one container, because `BpmnParse.parseScope` parses a nested scope's activities and their flows before the parent registers its own catches, so a throw inside a subprocess never finds a catch in the parent, and `ScopeImpl.findActivityAtLevelOfSubprocess` refuses the other direction.
A throw with no catch of its name is an error, the analogue of an unresolved `goto`, since `parseSequenceFlow` refuses to deploy a flow into a link source whose name has no target; a catch with no throw is a warning, since the engine deploys it, a modeller's document can carry one, and printed output from an import has to re-validate without an error.
Engine settings and listeners on `emit link` are refused one per item, because the throw gets no activity, while the same items on `await link` are allowed, because `BpmnParse.parseIntermediateCatchEvent` runs `parseAsynchronousContinuationForActivity` and `parseExecutionListenersOnScope` for a link catch like any other.

Nothing enters the catch is the one rule stricter than the engine: `parseSequenceFlow` gives a flow into the catch an ordinary transition and `IntermediateCatchLinkEventActivityBehavior.execute` leaves at once, so the shape deploys and runs as a pass-through.
This surface refuses it anyway, because a link target in a diagram never has an incoming flow, so the shape is not one a modeller's document produces, and the printer has to be able to place an imported catch after a statement whose flow has already ended, which a live fall-through into the catch would make ambiguous.

What a link pair buys at runtime is nothing.
`IntermediateCatchLinkEventActivityBehavior.execute` is a single `leave`, and `HistoryParseListener.parseIntermediateCatchEvent` skips a link catch by type, so history never records it.
Against a plain sequence flow the pair adds one activity instance that never waits and an optional async point on the catch.
That is why the argument for this surface is notation fidelity and not execution: a link in a `.bpmnscript` file exists so the file can say what the diagram said.
`goto` stays the way an author jumps, and link is not recommended in hand-written source.

### Consequences

- Good, because a document carrying a link pair imports instead of being refused, and it re-exports as the same two events under the same name, which the honest import contract (ADR-0012) requires and a `goto` rewrite cannot give.
- Good, because link costs one dispatch case per layer: a fifth catch kind on the payload surfaces of ADR-0024, one `case 'link'` in each direction of the transform, and one row in the trigger vocabulary.
- Good, because every `await` is now nameable, so an author can `goto` a specific wait.
- Bad, because two constructs now spell one jump, and a reader who meets `emit link` has to be told it is a `goto` in the diagram's own notation.
- Bad, because `emit` is no longer always continuing; `emit link` is the one form that ends its chain, read off the trigger word.
- Bad, because link names are unique per file where a `goto` target is unique per container, so two subprocesses cannot each have a link called `Retry`.
- Bad, because a link catch nobody emits is dead code the validator can only warn about, since the engine deploys it and an imported document may carry one.
- Bad, because an async setting or a listener on `emit link` is refused rather than honoured, and nothing on the surface hints at why until the diagnostic says so.
- Bad, because the importer and the printer have to handle a graph with two disconnected components.

### Confirmation

`packages/transform/test/` pins the emitted pair in one object, the lowering to two disconnected nodes carrying one link name, and that nothing leaves the throw and nothing enters the catch at either hop.
`packages/language/test/` pins the name slot on `await`, a `goto` reaching a named await, the completion of `link` after `emit` and after a bare `await` but not in a race branch header, and the table "Validation - link events", one row per validator rule above, each asserting the complete diagnostic list.
The import half is confirmed by the frozen pair `tests/golden/link-events.{bpmnscript,bpmn}` with `tests/link-events.round-trip.test.ts`, which pins the five link events under their ids and link names at every hop and a printed source that recompiles clean.
The Docker-gated case in `tests/e2e/event-positions.test.ts` deploys `order-rework` compiled and again round-tripped and runs the same journey on both, the one place the claim that the pair deploys and runs can be shown.

## More Information

Related decisions: ADR-0012 (the honest import contract, under which a rewrite of what is on the wire is not an option).
ADR-0031 (the race, whose branch headers refuse `link` because the engine refuses a link catch after an event-based gateway).
