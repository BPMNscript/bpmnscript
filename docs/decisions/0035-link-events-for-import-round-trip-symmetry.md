---
status: accepted
date: 2026-09-12
decision-makers: Marlon Kranz
---

# Link events for import round-trip symmetry

## Context and Problem Statement

ADR-0020 set the `await` trigger scope at message, timer, signal, and conditional, and left link out by name.
Its reason: link is BPMN's own off-page connector, built for splitting one diagram across pages, and `goto` already names a jump inside one textual source, so link would duplicate an existing mechanism for a diagramming problem a single `.bpmnscript` file never has.
That reasoning is correct and it stays.
It is a claim about authoring, about what a person writing this language needs, and nothing here contradicts it.

It is silent about the other direction.
A modeller's existing document can carry a link pair, and the importer refuses `bpmn:linkEventDefinition` by name on both the intermediate throw and the intermediate catch, so such a document does not import at all.
The one approximation on offer does not fit the import contract.
ADR-0014 lets the importer warn on a drop that changes nothing the engine runs and requires a refusal for everything else; at no point does it let the importer rewrite what is on the wire into a shape the surface prefers.
Reading a link pair as a `goto` would be that rewrite.
A `goto` compiles to one sequence flow, so the re-exported XML holds one edge where the incoming document held two events, and the author's own notation is gone.
The document that comes out is not the document that went in.

So the question is whether a construct this language does not need for authoring should exist anyway, for the sake of what a diagram already says.
Two reasons answer yes: better support for existing models, and round-trip symmetry.
The second rules out every answer short of a full surface.

## Decision Drivers

- Import coverage of existing models.
  Modelers built on bpmn-js, the Camunda Modeler among them, offer both ends of a link pair, and a document drawn with one is refused today.
- Round-trip symmetry under ADR-0014.
  A construct the importer maps has to re-export as the same XML, and a link pair mapped to a `goto` does not.
- Reuse of what is built.
  ADR-0017's payload surfaces already carry a quoted name for message and signal, and ADR-0016's terminality rule already decides from the printed words whether a statement ends its chain; a fifth catch kind should cost one dispatch case per layer, not a second mechanism.
- The engine's own link semantics.
  Operaton correlates the two ends by name in one table per parsed file, creates no activity for the throw, and rewires flows at deploy time; those facts decide most of the validator rules before this surface gets a say.
- The cost of a second way to spell a jump.
  Two constructs with one meaning is a real price, and this decision has to say what is bought for it.

## Considered Options

- Keep refusing a link definition on import, as ADR-0020 decided
- Import a link pair as a `goto`, and never author one
- A full surface, `emit link` and a named `await link`

## Decision Outcome

Chosen: the full surface, `emit link ToRetry("Retry")` and `await link AtRetry("Retry")`, because it is the only option under which a document carrying a link pair imports and re-exports as itself.

The surface reads name after trigger, the way `throw` and `emit` already spell a named event statement.
The grammar comment on those two rules gives the reason: one token of lookahead places the name, since an `ID` after the trigger predicts a name and anything else ends the statement, every statement being keyword-led.
Name first is the shape ADR-0020 tried on `await` and Chevrotain reported as ambiguous, and it would also break every `emit` in the corpus.
The verb is `emit` rather than `throw` because `throw` lowers to `bpmn:endEvent` and a link throw is a `bpmn:intermediateThrowEvent`; a `throw link` is refused with a message pointing at `emit link`.
`emit link` nonetheless ends its chain, as a `goto` does.
`BpmnParse.parseIntermediateThrowEvent` records the throw in `eventLinkSources` and returns before creating an activity, so a flow leaving the throw finds no source and `BpmnParse.parseSequenceFlow` reports it as an invalid source; the token continues at the catch and nowhere else.
This is the one `emit` whose chain ends, and the two printed words `emit link` decide it, never position, so ADR-0016's round-trip argument for terminality read off the text still holds.

The link name is quoted text, `link("Retry")`, like a message or signal name.
It keys the engine's own table and declares nothing, so it is not a declared code in the sense ADR-0030 gives error and escalation, and it reuses the required-name check, the bareword diagnostic, and the completion snippet the quoted kinds already have.

`await` gains the optional name slot `emit` has, in the same trigger-first position.
The name is legal on every trigger, as in `await message Paid("Paid")`, and the id is synthesized when it is omitted.
This reverses ADR-0020's "no authored name" for every `await`, not only for a link catch, because a link catch has to be nameable to keep its id across an import and a link-only slot would need a validator rule with no engine reason behind it.
A named `await` is a `goto` target and takes part in the duplicate-name and reserved-name rules like any named step.
A link catch is the one exception: it is entered by `emit link` of the same name and by nothing else, so a `goto` onto one is refused.
No `await` of any kind is a boundary host.

In the IR both ends carry `{ kind: 'link'; linkName: string }` and no flow runs between them.
The precedent is `BoundaryEvent.attachedToRef`, a node with no incoming flow wired to another by a reference rather than by an edge, not `SubProcess.element`, which is a tag on one node with no graph consequence.
The IR holds no reference field between the two ends because the engine matches them by name alone; an id reference would be a second fact that can drift from the first.
The restructuring analysis wires a link catch to its container's virtual entry the same way it wires a start event and a boundary event, since nothing flows into it: without that edge nothing in its chain has an immediate dominator, and a branch inside a rework chain prints as `goto`s instead of an `if`.
The element `name` attribute is stamped from the link name on both ends.
`BpmnParse.parseIntermediateLinkEventCatchBehavior` warns at deploy when the two differ and recommends they match, and modelers render the element name as the label, so stamping it keeps the deployment clean and the diagram readable.

The validator enforces the rules the engine decides, each in the tier the engine's behaviour justifies.

- One `await link` per name in the whole file, at any depth.
  `eventLinkTargets` is a field of `BpmnParse` that is never cleared between scopes, and `parseIntermediateLinkEventCatchBehavior` refuses the second catch of a name it already holds.
  This is stricter than `goto`, whose targets are container-scoped, and it is the one place link is less expressive than what it duplicates.
- Both ends in one container.
  `BpmnParse.parseScope` parses a nested scope's activities and their flows before the parent registers its own catches, so a throw inside a subprocess never finds a catch in the parent, and `ScopeImpl.findActivityAtLevelOfSubprocess` refuses the other direction.
- Nothing leaves the throw.
  The engine reports such a flow as an invalid source, as above.
- Nothing enters the catch.
  Here the engine is more lenient than this surface: `BpmnParse.parseSequenceFlow` gives a flow into the catch an ordinary transition, and `IntermediateCatchLinkEventActivityBehavior.execute` leaves at once, so the shape deploys and runs as a pass-through.
  This surface refuses it anyway, on two grounds.
  A link target in a diagram never has an incoming flow, so the shape is not one a modeller's document produces, and the printer has to be able to place an imported catch after a statement whose flow has already ended, which a live fall-through into the catch would make ambiguous.
  The statement before an `await link` must therefore end its chain: an `end`, a `throw`, a `goto`, an `emit link`, or a compound whose every branch does one of those.
- No link in a branch of a multi-branch `await`.
  `BpmnParse.parseIntermediateCatchEvent` refuses a link catch after an event-based gateway.
- A throw with no catch of its name is an error.
  `BpmnParse.parseSequenceFlow` refuses to deploy a flow into a link source whose name has no target, the analogue of an unresolved `goto`.
- A catch with no throw of its name is a warning.
  The engine deploys it, and a comment beside the rewiring says so and leaves the warning unwritten; a modeller's document can carry one, and printed output from an import has to re-validate without an error.
- Engine settings and listeners on `emit link` are refused, one error per item.
  The throw gets no activity, so `asyncBefore`, `jobPriority`, and every listener written there would never run.
  The same items on `await link` are allowed, because `BpmnParse.parseIntermediateCatchEvent` runs `parseAsynchronousContinuationForActivity` and `parseExecutionListenersOnScope` for a link catch like any other.
- A link into a `parallel` or multi-branch `await` branch from outside is refused, mirroring the `goto` rule, because the join would never complete.
- Many throws to one catch stay legal, as they are in the engine.

What a link pair buys at runtime is nothing.
`IntermediateCatchLinkEventActivityBehavior.execute` is a single `leave`, and `HistoryParseListener.parseIntermediateCatchEvent` skips a link catch by type, so history never records it.
Against a plain sequence flow the pair adds one activity instance that never waits and an optional async point on the catch.
That is why the argument for this surface is notation fidelity and not execution: a link in a `.bpmnscript` file exists so the file can say what the diagram said.

`goto` stays the way an author jumps, and link is not recommended in hand-written source.
A `goto` target is scoped to its container and needs no name that is unique across the file, it draws no deploy-time table, and it prints as the same one edge it compiles to.
The READMEs say so beside the link rules.

### Consequences

- Good, because a document carrying a link pair imports instead of being refused, and it re-exports as the same two events under the same name.
- Good, because the round trip is symmetric: what the importer maps, the compiler emits unchanged, which ADR-0014 requires and a `goto` rewrite cannot give.
- Good, because link costs one dispatch case per layer: a fifth catch kind on the payload surfaces of ADR-0017, one `case 'link'` in each direction of the transform, and one row in the trigger vocabulary.
- Good, because every `await` is now nameable, so an author can `goto` a specific wait, which ADR-0020 listed as its own bad consequence.
- Bad, because two constructs now spell one jump.
  A reader who meets `emit link` has to be told it is a `goto` in the diagram's own notation, and the READMEs carry that sentence.
- Bad, because `emit` is no longer always continuing; `emit link` is the one form that ends its chain, read off the trigger word.
- Bad, because link names are unique per file where a `goto` target is unique per container, so two subprocesses cannot each have a link called `Retry`.
- Bad, because a link catch nobody emits is dead code the validator can only warn about, since the engine deploys it and an imported document may carry one.
- Bad, because an async setting or a listener on `emit link` is refused rather than honoured, and nothing on the surface hints at why until the diagnostic says so.
- Bad, because the importer and the printer have to handle a graph with two disconnected components, the work that makes the import half of this decision real and is confirmed under the names below.

### Confirmation

`packages/transform/test/ir-to-xml.test.ts` pins the emitted pair in one object: "emits a link pair as two named events sharing one link name, nothing leaving the throw, nothing entering the catch, both laid out".
`packages/language/test/parsing.test.ts` pins the name slot, "`await` takes an optional name between the trigger and the payload, as `emit` does", and `packages/language/test/scoping.test.ts` pins "a goto reaches a named await".
`packages/transform/test/ast-to-ir.test.ts` pins "lowers a link pair as two disconnected nodes carrying one link name: nothing leaves the throw, nothing enters the catch".
`packages/language/test/completion.test.ts` pins that `link` is offered after `emit` and after a bare `await`, and "a race branch header offers every await trigger but link".
`packages/language/test/validating.test.ts` carries the table "Validation - link events", one row per rule above, each asserting the complete diagnostic list, from "a link pair in one container is clean, and the catch opens a new chain after the throw" through "throw link points at emit link".
The import half is confirmed by the frozen pair `tests/golden/link-events.{bpmnscript,bpmn}` with `tests/link-events.round-trip.test.ts`, which pins the five link events under their ids and link names at every hop, no flow leaving a throw or entering a catch, and a printed source that recompiles clean.
The Docker-gated case in `tests/e2e/event-positions.test.ts` deploys `order-rework` compiled and again round-tripped, and runs the same journey on both, the one place the claim that the pair deploys and runs can be shown.

## Pros and Cons of the Options

### Keep refusing a link definition on import

- Good, because the surface stays where ADR-0020 put it, with four catch kinds and no second way to jump.
- Good, because no grammar rule, vocabulary row, or validator rule is added.
- Bad, because every diagram using BPMN's own off-page connector is unimportable, and the modelers this tool's users draw in offer one.
- Bad, because the refusal is not one ADR-0014 asks for: the engine deploys and runs a link pair, so there is no execution loss behind it.

### Import a link pair as a `goto`, and never author one

- Good, because the authoring surface does not change at all.
- Good, because the reader of the printed source sees the jump in the form this language already has.
- Bad, because re-export changes the XML.
  The `goto` compiles to one sequence flow, so two events and their definitions come out as one edge and the diagram's notation is lost.
  Under ADR-0014 that is an approximation, and round-trip symmetry rules it out by construction.
- Bad, because the printer would have to decide which `goto` edges were links, a fact the IR would no longer hold.

### A full surface, `emit link` and a named `await link`

- Good, because the import maps one-to-one and the export reproduces it.
- Good, because the payload surface, the required-name check, and the completion snippet are the ones message and signal already use.
- Bad, because the language now has two constructs for one jump, and has to say in its own documentation which one to write.
- Bad, because every `await` gains a name slot to make one kind of `await` nameable.

## More Information

Amends ADR-0020, whose four-trigger scope and "no authored name" hold for the reasons given there as claims about authoring; the trigger scope gains `link` and every `await` gains an optional name for the import direction.

Amends ADR-0025, whose event-based gateway refusal relied on `mapIntermediateCatchEvent` turning a link away wherever it appeared; that refusal now rests on the importer's rule that no flow enters a link catch.

Related decisions: ADR-0014 (the honest import contract, under which a rewrite of what is on the wire is not an option).
ADR-0016 (the terminality rule; `emit link` is the one `emit` that ends its chain, but the two printed words decide it, so terminality is still read off the text and never off position).
ADR-0017 (the payload surfaces the link name reuses).
ADR-0019 (boundary events, whose `attachedToRef` is the precedent for a node with no incoming flow wired by a reference).
ADR-0025 (the race, whose branch headers refuse `link` because the engine refuses a link catch after an event-based gateway).
ADR-0030 (declared codes, which a link name is not).

Engine behaviour was read from `BpmnParse.java`, `ScopeImpl.java`, `IntermediateCatchLinkEventActivityBehavior.java`, and `HistoryParseListener.java` in operaton-engine 2.1.0, with line numbers as of that version: `eventLinkTargets` and `eventLinkSources` at `BpmnParse.java:342-343`; `parseScope` calling `parseActivities` before `parseIntermediateCatchEvents` at 767-768; `parseIntermediateCatchEvent` at 1547-1600, with the event-based gateway refusal at 1582, the async continuation at 1559, and the listeners at 1594; `parseIntermediateLinkEventCatchBehavior` at 1603-1623, with the duplicate refusal at 1612 and the name warning at 1617; `parseIntermediateThrowEvent`'s early return at 1651-1657; `parseSequenceFlow`'s rewiring at 4331-4344, its invalid-source error at 4366, and the ordinary transition at 4392; `ScopeImpl.findActivityAtLevelOfSubprocess` at 91-102; `IntermediateCatchLinkEventActivityBehavior.execute` at 29-32; and `HistoryParseListener.parseIntermediateCatchEvent` at 202-207.
