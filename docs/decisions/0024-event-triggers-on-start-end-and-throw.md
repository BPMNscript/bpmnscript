---
status: accepted
date: 2026-08-29
decision-makers: Marlon Kranz
---

# Event Triggers at the Process Boundary: Three Start Kinds, `terminate` on `end`, and the Message End on `throw`

## Context and Problem Statement

Every event trigger this language writes is caught or raised inside a process that is already running.
No trigger reaches the two positions that bracket a process.
So a correlated order, a broadcast, and a nightly schedule all have to be modeled outside the process they start.
A branch that decides nothing else should continue cannot stop a sibling parked on a user task.
Six BPMN elements sit in that gap: a message, signal, or timer start event, a terminate end event, a message end event, and a message intermediate throw.
Where does each one land, given that `start`, `end`, `throw`, and `emit` could all plausibly carry the clause?
And which of them does Operaton actually execute?
The specification is more permissive at the start position than the engine is, in a direction that produces no error.

## Decision Drivers

- One IR shape has to print in exactly one form.
  Otherwise the printer arbitrates on every decompile by a rule invisible to whoever reads the result.
- The honest import contract (ADR-0014) refuses what changes the run and warns only about drops that do not.
  So Operaton's parser rather than the BPMN specification decides what is worth emitting.
- Whatever import accepts, the decompiler has to be able to write back.
- Every trigger word is a soft identifier (ADR-0016), so a new clause stays unambiguous by token position alone.
  A rule that reads unambiguously to a human is not evidence.

## Considered Options

- `throw message "Name"` and `emit message "Name"` for the message end and the message intermediate throw
- `end E message "Name"`, the message end as a clause on the end statement
- `end <id> <label>? terminate` for the terminate end event
- `throw terminate`
- Message, signal, and timer as the triggers a start event carries
- Every trigger the specification allows on a start event, adding error, escalation, compensation, and conditional
- A start trigger only on a process's own start event
- A start trigger on any start event, including a sub-process's and an event handler's

## Decision Outcome

Chosen options: `throw message "Name"` and `emit message "Name"` for the message end and the message intermediate throw.
`end <id> <label>? terminate` for the terminate end.
Message, signal, and timer as the triggers a start event carries.
A process's own start event as the only position that may carry one.
The terminate is the one place here where the option costing no grammar was not taken.
`end` has the label slot a diagram's terminate node needs, and `throw` has none.

`end E message "Name"` still parses, deliberately.
A kind belonging on `throw` earns a validator message naming the statement to write, instead of a parse error (`endTriggerMessage`).
The validator refuses the two illegal start positions the same way, each with its own wording (`checkStartEvent`, `packages/language/src/bpmn-script-validator.ts`).

The accepted set is `START_TRIGGERS` (`packages/language/src/vocabulary.ts`).
Import refuses what lies outside it with wording about the degradation rather than about the element type (`IGNORED_START_SUBJECTS` and `readStartTrigger`).
A conditional start is refused in different words, because Operaton does execute one.

A container has one start event, already implied by requiring an explicit `start` to be the first statement of its body (`checkStartPosition`).
A modeler document carrying two of them is refused by name and by count (`refuseMultipleStartEvents`, `packages/transform/src/xml-to-ir.ts`).

Neither clause needs a new reserved word.
`name=ID` is mandatory and comes first in both the `StartEvent` and `EndEvent` rules (`packages/language/src/bpmn-script.langium`).
The second token therefore decides everything: a `STRING` is the label, an `ID` the trigger, and a `{` the settings block.
Nothing else can appear there, because every statement in this grammar is keyword-led.
Both rules were built into a live Langium parser with Chevrotain's self-analysis on.
The generator reported no ambiguity.
`terminate` and the three start words therefore stay soft identifiers, and `var terminate: string` parses beside `end Done terminate`.

One class of name cannot be imported at all, for a lexical rather than a semantic reason.
`RAW_TEMPLATE` is declared before `STRING` (`packages/language/src/bpmn-script.langium`), so a quoted name opening with `${` lexes as a raw expression.
Import refuses such a name wherever a throw or catch position resolves its root (`resolveNamedRootRef`, `packages/transform/src/xml-to-ir.ts`).
The diagnostic names the `#{...}` form that survives.
A message start refuses both spellings, because Operaton rejects an expression anywhere in that name.

### Consequences

- Good, because the message end and the message intermediate throw cost no grammar and read like the signal end and signal emit beside them.
  One IR shape keeps one printed form.
- Good, because the three start triggers reuse the payload surfaces and name-keyed roots ADR-0017 already built.
  The set stops where the engine stops, so an import either runs as it reads or refuses and names the element that stopped it.
- Bad, because a thrown message carrying a send implementation refuses on import rather than importing without it (`refuseMessageThrowImplementation`).
  `operaton:class`, `expression`, `delegateExpression`, `type`, `topic`, and an `<operaton:connector>` child are what make the engine really send the message.
  Dropping one would turn a real send into a no-op.
- Bad, because a terminate end always prints, even when its id was synthesized (`isElidedOnPrint`, `packages/transform/src/ir-to-dsl.ts`).
  A modeler document decompiles to `end EndEvent_1 terminate`, and re-parsing reports the reserved prefix (ADR-0010).
- Bad, because a branch that terminates does not rejoin.
  An `if` whose branch ends at a terminate prints as a `goto`, and a `parallel` whose branch terminates leaves its join with one incoming flow (`joinContinuation`).

### Confirmation

`packages/language/test/parsing.test.ts` and `validating.test.ts` pin the two clauses token by token and every diagnostic behind them.
`packages/transform/test/xml-to-ir.test.ts` pins each refusal by error class and message.
`ast-to-ir.test.ts` and `ir-to-dsl.test.ts` pin the lowering and the printed line for every authored shape.
`packages/cli/test/decompile-contract.e2e.test.ts` pins that a refused trigger exits nonzero and writes no output file.
The frozen pair `tests/golden/event-positions.{bpmnscript,bpmn}` holds a message start, an `emit message`, a `throw message`, and a terminate end.
`tests/event-positions.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/new-constructs.round-trip.test.ts` carries the timer and signal starts.
`tests/e2e/event-positions.test.ts` deploys three processes to a real Operaton through Testcontainers.
A correlated message with no instance to aim at creates one, a broadcast signal creates one with both branches active, and a timer parks a job.
The terminate cancels a sibling branch parked on a user task, and both thrown messages pass the token through to completion.
That last result is what shows an implementation-free message throw deploys and runs.

## Pros and Cons of the Options

### `throw message "Name"` and `emit message "Name"`

- Good, because both statements already parse a trigger word, an optional name, and a quoted code, so it needs no grammar.
- Bad, because an id matching the synthesized shape drops off a printed throw, so a `goto` cannot target a nameless message end.

### `end E message "Name"`

- Bad, because one IR shape would carry two printed forms, and the printer would have to choose per kind.

### `end <id> <label>? terminate`

- Good, because `end` has the label slot, so a diagram's terminate node keeps its caption through a round trip.
- Good, because it says what the element does, which is to end rather than to raise.

### `throw terminate`

- Bad, because `throw` means raise this event and end this path, and a terminate raises nothing and ends every path.
- Bad, because `throw` has no label slot, so importing a labeled terminate would warn about a caption a diagram carries.

### Message, signal, and timer on a start

- Good, because these are the three the engine builds a start behavior for, so what is written is what runs.

### Every trigger the specification allows on a start event

- Bad, because Operaton's `BpmnParse` ignores an error, escalation, or compensation definition in `parseProcessDefinitionStartEvent` and builds a `NoneStartEventActivityBehavior` instead.
- Bad, because such a document would import and print without a diagnostic, then start unconditionally.

### A trigger only on a process's own start

- Good, because Operaton rejects a trigger on an embedded sub-process start, so accepting one would produce an undeployable file.
- Good, because an event handler's trigger has exactly one home, the `on` header, so nothing competes for it.

### A trigger on any start

- Bad, because a sub-process start carrying one is a deployment failure rather than a degradation.

## More Information

Extended by ADR-0026 (task kinds on the authoring surface), which retires the message-throw implementation refusal above: Operaton reads that implementation off the `bpmn:messageEventDefinition`, so the same attributes on the event itself are inert.

Related decisions: ADR-0016 (soft trigger words and the `throw`/`emit` terminality rule).
ADR-0017 (the payload surfaces the three start triggers reuse, including the timer particle mapping).
ADR-0014 (the honest import contract behind every refusal here).
ADR-0013 (the reason a start trigger is a clause rather than a declaration).
ADR-0020 (the live-parser ambiguity check and the rejected `await <name> <trigger>` shape).
ADR-0009 (the restructuring that prints a terminating branch as a `goto`).
ADR-0010 (the reserved synthesized-id prefixes a printed terminate end meets).
