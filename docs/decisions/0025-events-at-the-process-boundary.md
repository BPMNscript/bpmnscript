---
status: accepted
date: 2026-08-29
decision-makers: Marlon Kranz
---

# Events at the process boundary: starts, ends and throws

## Context and Problem Statement

Most event triggers this language writes are caught or raised inside a process that is already running.
The two positions that bracket a process are the open question.
A correlated order, a broadcast, and a nightly schedule would otherwise be modeled outside the process they start, and a branch that decides nothing else should continue could not stop a sibling parked on a user task.
Seven BPMN elements sit in that gap: a message, signal, timer, or condition start event, a terminate end event, a message end event, and a message intermediate throw.
Where does each one land, given that `start`, `end`, `throw` and `emit` could all plausibly carry the clause, and which of them does Operaton actually execute?
The specification is more permissive at the start position than the engine is, in a direction that produces no error.

How many starts a process may carry is the second half of the same question.
Requiring an explicit `start` as the first statement of its container reads one start event per container off that rule, but Operaton draws the line elsewhere.
`BpmnParse.parseStartEvents` accepts any number of start events on a process definition, and only a scope that is not a process goes through `BpmnParse.parseScopeStartEvent`, which reports an error on the second start of an embedded sub-process, a transaction, or an event sub-process.
One start per container is therefore an invariant of a surface, not of the engine, and it costs real files: a modeler document with a plain start beside a message start, the ordinary shape of a process entered both by hand and by correlation.
So where may a second `start` sit on the page, what does the flow around it mean, and which facts about a start set are worth a diagnostic?

## Decision Drivers

- One IR shape has to print in exactly one form.
  Otherwise the printer arbitrates on every decompile by a rule invisible to whoever reads the result.
- The honest import contract refuses what changes the run and warns only about drops that do not, so Operaton's parser rather than the BPMN specification decides what is worth emitting, and a refusal has to name an engine reason.
- Whatever import accepts, the decompiler has to be able to write back in a form that re-desugars to the same graph.
- Every trigger word is a soft identifier, so a new clause stays unambiguous by token position alone.
  A rule that reads unambiguously to a human is not evidence.
- The page must say what the graph does.
  Steps run top to bottom and sequence flow is never written out, so a statement the flow runs past without entering would be the one silent exception.
- The engine's start matrix is silent at deploy time in two places that bite at runtime, and this surface reports what the engine will not.
- No grammar change for the start set: `Statement` already admits a `start` anywhere in a block, so that half is a question of validation and lowering.

## Considered Options

- `throw message("Name")` and `emit message("Name")` for the message end and the message intermediate throw, which need no grammar, since both statements already parse a trigger word, an optional name, and a quoted code, but drop an id matching the synthesized shape off a printed throw, so a `goto` cannot target a nameless message end.
- `end E message("Name")`, the message end as a clause on the end statement, under which one IR shape would carry two printed forms and the printer would have to choose per kind.
- `end <id> terminate(label: "...")` for the terminate end event, which says what the element does, to end rather than to raise, and carries a label, so a diagram's terminate node keeps its caption through a round trip.
- `throw terminate`, where `throw` means raise this event and end this path while a terminate raises nothing and ends every path, and where the missing label would make an imported labeled terminate warn about a caption a diagram carries.
- Message, signal, timer and condition on a start, the four the engine builds a start behavior for, so what is written is what runs.
- Every trigger the specification allows on a start event, adding error, escalation and compensation, which Operaton's `BpmnParse` ignores in `parseProcessDefinitionStartEvent`, building a `NoneStartEventActivityBehavior` instead, so such a document would import and print without a diagnostic and then start unconditionally.
- A trigger only on a process's own start event, since Operaton rejects a trigger on an embedded sub-process start and an event handler's trigger has exactly one home, the `on` header.
- A trigger on any start event, including a sub-process's and an event handler's, where a sub-process start carrying one is a deployment failure rather than a degradation.
- Flat sibling `start` statements in a process body, which need no grammar change and let one file carry the shape a modeler draws.
- A grouped entry block holding every start, which invents a container the engine has no counterpart for.
- A process body only by engine rule, or every container with the engine's refusal surfacing at deployment, the second of which hands the author a deployment failure the validator could have named.
- An error naming the ambiguity when a start follows a statement whose flow is still live.
- A start the flow runs past, joining its chain to the one before it, which refuses no page, but would be the one place where the page does not say what the graph does.

## Decision Outcome

Chosen: `throw message("Name")` and `emit message("Name")` for the message end and the message intermediate throw, `end <id> terminate(label: "...")` for the terminate end, message, signal, timer and condition as the triggers a start event carries, a process's own start event as the only position that may carry one, and flat sibling `start` statements in a process body with an error for a start after a live chain and a warning for each of the two silent engine facts.
The terminate is the one place here where the option costing no grammar was not taken: `end` carries the label a diagram's terminate node needs, and `throw` drops one.

`end E message("Name")` still parses, deliberately.
A kind belonging on `throw` earns a validator message naming the statement to write, instead of a parse error (`endTriggerMessage`), and the validator refuses the two illegal start positions the same way, each with its own wording (`checkStartEvent`, `packages/language/src/bpmn-script-validator.ts`).
The accepted trigger set is `START_TRIGGERS` (`packages/language/src/vocabulary.ts`), and import refuses what lies outside it with wording about the degradation rather than about the element type (`IGNORED_START_SUBJECTS` and `readStartTrigger`).
A conditional start is accepted rather than refused, because the engine dispatches on it where it ignores an error, escalation, or compensation one, so the set that stops where the engine stops includes it.

Neither clause needs a new reserved word.
`name=ID` is mandatory and comes first in both the `StartEvent` and `EndEvent` rules (`packages/language/src/bpmn-script.langium`), so the second token decides everything: an `ID` is the trigger, a `(` the settings, and a `{` the members.
Nothing else can appear there, because every statement in this grammar is keyword-led, and both rules were built into a live Langium parser with Chevrotain's self-analysis on, which reported no ambiguity.
`terminate` and the four start words therefore stay soft identifiers, and `var terminate: string` parses beside `end Done terminate`.

The attributes that make the engine really send a thrown message, `operaton:class`, `expression`, `delegateExpression`, `type`, `topic`, and an `<operaton:connector>` child, are read off the `bpmn:messageEventDefinition`, which is the surface the task kinds carry; the same attributes on the event element itself are inert.

A `start` opens a chain and takes no incoming flow, so it may sit first in the process body, directly after another `start`, or after a statement whose flow always ends or redirects, and a start after a step whose flow is still live is refused with a message naming the fix, because either reading of that page invents a flow the author did not write.
That freedom holds for a process body only: an embedded `subprocess`, an `attempt` block, and an event-handler body keep exactly one start, at their head, because `parseScopeStartEvent` rejects the second start of any scope that is not a process definition, and a second start in one of them is refused on import by count (`checkStartEventCount`, `packages/transform/src/xml-to-ir.ts`), naming that engine reason, while a process is let through.

Two warnings report what the engine decides in silence.
`BpmnParse.selectInitial` makes a lone start of any kind the default, and among several starts only a plain or timer start; with two or more starts and none of those two kinds the process has no default, and `ProcessDefinitionImpl.ensureDefaultInitialExists` throws when such a process is started by key, so the validator warns on the process name.
`BpmnParse.parseStartFormHandlers` binds a start form to the default start alone, so a `form` block on any other start is parsed and never offered, and the validator warns on that block.
Both stay warnings: the process deploys and runs, and being entered by message or signal is the point of writing such a process.

The decompiler walks an unnamed plain start ahead of every other, since such a start is elided on print and re-derived by the compiler at the head of the body, so its chain has to be the first one printed, else the entry point is lost on the way back.
One corner is accepted rather than fixed.
A start whose first step is a synthesized gateway prints the branch when every start into that gateway prints, so `start A`, `start B`, `if (x) { ... }` round-trips clean, but the corner survives when one of those starts is the elided plain start, the one carrying the minted `StartEvent_<process>` id and no content: its chain is walked first, the `if` printed for it consumes the gateway's out-edges, and the other start prints back as a dropped-edge marker.
No source spells that shape, since `goto` names an authored statement and never a synthesized gateway, so it reaches the printer through an imported document alone, and the authoring rule that keeps clear of it is to write each start ahead of a named step, which the golden fixture and the `support-ticket` example both obey.

### Consequences

- Good, because the message end and the message intermediate throw cost no grammar and read like the signal end and signal emit beside them.
  One IR shape keeps one printed form.
- Good, because the four start triggers reuse the payload surfaces and name-keyed roots ADR-0024 already built.
  The set stops where the engine stops, so an import either runs as it reads or refuses and names the element that stopped it.
- Good, because a process entered by hand and by message, a common reason to draw two starts, is one file and one diagram instead of two processes.
- Good, because the chain rule is one the reader can check on the page, and the desugarer never has to define the ambiguous shape.
  Operaton does not reject a start event with an incoming flow: `BpmnParse.parseSequenceFlow` has no arm for a start-event destination, and `NoneStartEventActivityBehavior` inherits `FlowNodeActivityBehavior.execute`, which leaves the activity at once, so a start the flow runs past would deploy and run as a pass-through step, and the mistake would show only in history.
  Refusing the shape is what rules that out.
- Neutral, because `initiator` is read off every start and set on the process definition by `BpmnParse.parseProcessDefinitionStartEvent`, last one wins, and the validator warns on every start but the last that names one.
- Neutral, because a message start whose name is already subscribed by another deployed definition fails in `BpmnDeployer.addMessageStartEventSubscription`, a fact about the deployment rather than the file, and out of this tool's reach.
- Bad, because a terminate end always prints, even when its id was synthesized (`isElidedOnPrint`, `packages/transform/src/ir-to-dsl.ts`).
  A modeler document decompiles to `end EndEvent_1 terminate`, and re-parsing reports the reserved prefix.
- Bad, because a branch that terminates does not rejoin.
  An `if` whose branch ends at a terminate prints as a `goto`, and a `parallel` whose branch terminates leaves its join with one incoming flow (`joinContinuation`).
- Bad, because the printed form of a process with several starts is not always the authored one: starts entering the same step print back to back above it, even one written after an `end` with a `goto` onto that step.
  The graph is the same, which the idempotence block asserts, but the reader has to learn the shape.
- Bad, because the corner above means an imported document with an unnamed plain start into a shared synthesized gateway round-trips with a warning rather than cleanly.

### Confirmation

`packages/language/test/parsing.test.ts` and `validating.test.ts` pin the two clauses token by token and every diagnostic behind them, and the validator rows pin every position a start may take, the chain error, and both warnings.
`packages/transform/test/xml-to-ir.test.ts` pins each refusal by error class and message, `ast-to-ir.test.ts` and `ir-to-dsl.test.ts` the lowering and the printed line for every authored shape, and `packages/cli/test/decompile-contract.e2e.test.ts` that a refused trigger exits nonzero and writes no output file.
The frozen pair `tests/golden/event-positions.{bpmnscript,bpmn}` holds a message start, an `emit message`, a `throw message`, and a terminate end, and `tests/event-positions.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all; `tests/new-constructs.round-trip.test.ts` carries the timer, signal, and conditional starts, and the frozen pair `tests/golden/multiple-starts.{bpmnscript,bpmn}` holds four starts across two chains, its suite asserting at every hop that all four keep their trigger and none is the target of a sequence flow.
`tests/e2e/event-positions.test.ts` deploys to a real Operaton through Testcontainers: a correlated message with no instance to aim at creates one, a broadcast signal creates one with both branches active, a timer parks a job, the terminate cancels a sibling branch parked on a user task, and both thrown messages pass the token through to completion, which is what shows an implementation-free message throw deploys and runs.
The same suite starts `support-ticket`, a process with a plain and a message start, once by key and once by message, and each instance's history holds exactly its own start and the shared task, which is the assertion a pass-through start would fail.

## More Information

ADR-0024 carries the payload surfaces the four start triggers reuse, including the timer mapping.
