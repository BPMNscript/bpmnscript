---
status: accepted
date: 2026-09-12
decision-makers: Marlon Kranz
---

# Multiple start events on a process

## Context and Problem Statement

ADR-0024 required an explicit `start` to be the first statement of its container and read one start event per container off that rule.
Operaton draws the line elsewhere.
`BpmnParse.parseStartEvents` accepts any number of start events on a process definition, and only a scope that is not a process goes through `BpmnParse.parseScopeStartEvent`, which reports an error on the second start of an embedded sub-process, a transaction, or an event sub-process.
So "one start per container" was an invariant of this surface, not of the engine.
It cost real files: a modeler document with a plain start beside a message start, the ordinary shape of a process entered both by hand and by correlation, was refused on import by name and by count.
The two components that would have to carry several starts already did.
The restructuring analysis wires every start event to its container's virtual entry (ADR-0019), and the printer walks every start it finds.
Only the validator, the desugarer's chaining, and the import refusal stood in the way.
Where may a second `start` sit on the page, what does the flow around it mean, and which facts about a start set are worth a diagnostic?

## Decision Drivers

- No grammar change: `Statement` already admits a `start` anywhere in a block, so the question is one of validation and lowering, not of syntax.
- The page must say what the graph does.
  Steps run top to bottom and sequence flow is never written out, so a statement the flow runs past without entering would be the one silent exception.
- The honest import contract (ADR-0014): a shape the engine deploys and runs must import, and a refusal must name an engine reason.
- The engine's start matrix is silent at deploy time in two places that bite at runtime, and this surface reports what the engine will not.
- Whatever import accepts, the decompiler has to print in a form that re-desugars to the same graph.

## Considered Options

For the surface:

- Flat sibling `start` statements in the process body
- A grouped entry block holding every start

For a start that follows a statement whose flow is still live:

- An error naming the ambiguity
- A start the flow runs past, joining its chain to the one before it

For the two facts the engine leaves silent, no default start and a form on a start that is not the default:

- A warning
- An error
- Documentation only

For the scope:

- A process body only, by engine rule
- Every container, with the engine's refusal surfacing at deployment

## Decision Outcome

Chosen: flat sibling `start` statements, a process body only, an error for a start after a live chain, and a warning for each of the two silent engine facts.

A `start` opens a chain and takes no incoming flow.
It may therefore sit first in the process body, directly after another `start`, or after a statement whose flow always ends or redirects: an `end`, a `throw`, a `goto`, or a compound whose every branch does one of those.
Starts written back to back open one chain together, so `start A`, `start B`, `user T` enters `T` from both.
A start after an `end` opens a chain of its own and reaches a shared step by `goto`, which is the shape the decompiler prints.
A start after a step whose flow is still live is refused with a message naming the fix, because either reading of that page invents a flow the author did not write.
No grammar changed for any of this.

The rule holds for a process body only.
An embedded `subprocess`, an `attempt` block, and an event-handler body keep exactly one start, at their head, because `BpmnParse.parseScopeStartEvent` rejects the second start of any scope that is not a process definition.
Import lifts the refusal for a process and keeps it for a sub-process and a transaction, naming that engine reason.

Two warnings report what the engine decides in silence.
`BpmnParse.selectInitial` makes a lone start of any kind the default, and among several starts only a plain or timer start; with two or more starts and none of those two kinds the process has no default, and `ProcessDefinitionImpl.ensureDefaultInitialExists` throws when such a process is started by key.
The validator warns on the process name.
`BpmnParse.parseStartFormHandlers` binds a start form to the default start alone, so a `form` block on any other start is parsed and never offered, and the validator warns on that block.
Both stay warnings: the process deploys and runs, and being entered by message or signal is the point of writing such a process.
Two plain or timer starts on one process is a deployment error `selectInitial` reports itself, so this surface does not repeat it and treats the first as the default.

The decompiler walks an unnamed plain start ahead of every other.
Such a start is elided on print and re-derived by the compiler at the head of the body, so its chain has to be the first one printed, else the entry point is lost on the way back.

One corner is accepted rather than fixed, the one ADR-0019 already records for a boundary chain.
A start whose first step is a synthesized gateway, as in `start A`, `start B`, `if (x) { ... }`, compiles to correct XML but prints back as a dropped-edge marker, because the gateway's out-edges were consumed by the `if` printed for the first chain.
The authoring rule that follows: write each start ahead of a named step.
The golden fixture and the `support-ticket` example both obey it.

### Consequences

- Good, because a process entered by hand and by message, a common reason to draw two starts, is one file and one diagram instead of two processes.
- Good, because the chain rule is one the reader can check on the page, and the desugarer never has to define the ambiguous shape.
  Operaton does not reject a start event with an incoming flow: `BpmnParse.parseSequenceFlow` has no arm for a start-event destination, and `NoneStartEventActivityBehavior` inherits `FlowNodeActivityBehavior.execute`, which leaves the activity at once, so a start the flow runs past would deploy and run as a pass-through step, and the mistake would show only in history.
  Refusing the shape is what rules that out.
- Neutral, because `initiator` is read off every start and set on the process definition by `BpmnParse.parseProcessDefinitionStartEvent`, last one wins, and the validator warns on every start but the last that names one.
- Neutral, because a message start whose name is already subscribed by another deployed definition fails in `BpmnDeployer.addMessageStartEventSubscription`, a fact about the deployment rather than the file, and out of this tool's reach.
- Bad, because the printed form of a process with several starts is not the authored one: every start after the first chain prints after that chain's `end`, followed by a `goto` onto the shared step.
  The graph is the same, which the idempotence block asserts, but the reader has to learn the shape.
- Bad, because the corner above means a start into a synthesized gateway round-trips with a warning rather than cleanly.

### Confirmation

The frozen pair `tests/golden/multiple-starts.{bpmnscript,bpmn}` holds four starts across two chains, and its suite asserts at every hop that all four keep their trigger and none is the target of a sequence flow.
`tests/e2e/event-positions.test.ts` deploys `support-ticket`, a process with a plain and a message start, to a real Operaton and starts it once by key and once by message; each instance's history holds exactly its own start and the shared task, which is the assertion a pass-through start would fail.
The validator rows in `packages/language/test/validating.test.ts` pin every position a start may take, the chain error, and both warnings.

## More Information

Amends ADR-0024, whose Decision Outcome stated one start per container; that now holds for a subprocess, a transaction, and an event handler only.

Related decisions: ADR-0019 (every start wired to the virtual entry, and the synthesized-gateway corner this decision inherits).
ADR-0014 (the honest import contract under which the process-level refusal is lifted).
