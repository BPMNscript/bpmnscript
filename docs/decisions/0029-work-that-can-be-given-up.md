---
status: accepted
date: 2026-08-31
decision-makers: Marlon Kranz
---

# Work that can be given up: `attempt` and `cancel`

## Context and Problem Statement

BPMN has a container for work abandoned as a unit: a `bpmn:transaction`, given up by an end event inside it carrying a `bpmn:cancelEventDefinition`, caught by a boundary event of the same kind.
Operaton rejects either cancel position outside such a container, so neither is expressible until the container is.
This grammar had no container to put them in, so any document carrying the element refused on import and the round trip stopped there.
The question this decision settles: what does the container head say, where may a cancel sit, and which shapes does the surface decline to carry?

## Decision Drivers

- ADR-0006 binds a keyword to what the author means rather than to the BPMN element behind it.
- ADR-0012 refuses what changes the run and warns only about drops that do not.
- A Langium statement keyword is lexer-global, so a word spent on a head is a name lost everywhere in a file.
- Operaton decides what deploys here, and a surface stricter than the engine owes a reason.

## Considered Options

- `attempt` as a second head on the existing sub-process rule, which names the intent rather than the tag and costs no AST type and no branch in anything that already asks whether a statement is a sub-process.
- `transaction` as the head, which is the BPMN element name and promises what the engine does not deliver: `BpmnParse.parseTransaction` installs the same `SubProcessActivityBehavior` that `parseSubProcess` installs for an ordinary block, so nothing is atomic, no transaction protocol runs, and nothing rolls back except what the author's own undo blocks reverse.
- A settings key on an ordinary block, `subprocess X(transaction: true)`, which fails the same test `sequential: true` failed for repetition (ADR-0022), since a boolean named after the element is that element wearing a DSL hat.
- A grammar rule of its own, which loses on cost: keeping the AST node `SubProcess` is what lets the scope provider, the linker, and every rule keyed on a sub-process reach the new head untouched.
- `cancel` carried on the `end` statement the way `terminate` is, rather than `throw cancel`, because it carries no code, always ends its path, and BPMN raises a cancel from an end event only.
- A host-less `on cancel` handler, which lowers to an event sub-process whose start event `parseScopeStartEvent` fails the deployment of, and which BPMN gives nothing to open on.
- A cancel end with no handler refused on import, rather than warned about, which would reject a document the engine deploys.
- A non-interrupting cancel handler imported as an interrupting one, rather than refused, which would change the run.

## Decision Outcome

Chosen options: `attempt` on the existing sub-process rule, `cancel` on the `end` statement, no host-less handler, the missing handler warned rather than refused, and the non-interrupting handler refused.

A block reads `attempt BookAndPay { ... }`, `end BookingAbandoned cancel` inside it gives that block up, and `on BookAndPay: cancel { ... }` catches it.
`attempt` says what the author means: run this block of work and, if it is given up, undo what it finished.
It is a hard keyword, so the name is lost everywhere in a file, while `cancel` is one word in both of its positions and stays a soft word that still lexes as an ordinary identifier, keeping the raise and the catch out of two vocabularies for one event.

Four shapes refuse on import, each because Operaton itself rejects the deployment: a cancel end outside an `attempt` block, a cancel handler on any other host, a second handler on one block, and the cancel definition on a host-less handler's start event.
`parseEndEvents` accepts a cancel end only where the container holding it is a transaction, so a branch inside the block is still inside it and a nested block is not, and the two boundary shapes are consecutive checks in `parseBoundaryCancelEventDefinition`.
A `cancelActivity="false"` handler refuses although the parser accepts it: `parseBoundaryEvents` gives it `ActivityStartBehavior.CONCURRENT_IN_FLOW_SCOPE`, and importing it as interrupting would change the run.

A cancel end whose block carries no handler warns instead, on both sides.
Parsing the handler is what wires the pair: `parseBoundaryCancelEventDefinition` calls `setCancelBoundaryEvent` on every `CancelEndEventActivityBehavior` among the block's direct children.
With no handler that reference stays null, and `CancelEndEventActivityBehavior.execute` opens on an `EnsureUtil.ensureNotNull` for it, so the document deploys and the first run stops with "Could not find cancel boundary event for cancel end event Activity(BookingAbandoned): cancelBoundaryEvent is null".
Refusing would reject a document the engine accepts, which the import contract does not license, so both sides warn and name that runtime failure.
A handler on a block whose body holds no cancel end warns for the same reason, since only a cancel end hands the run to it, through `CancelEndEventActivityBehavior.doLeave`.

### Consequences

- Good, because a document the engine runs as work that can be given up now imports, prints, and recompiles byte for byte, where before it stopped the import at the container.
- Good, because a block written with the new head and carrying no cancel anywhere is an ordinary block of work to the engine, which is what lets an imported transaction round-trip unchanged.
- Good, because such a block may carry its own `on compensation`, so an enclosing scope can undo it in turn: Operaton's `CompensationUtil.hasCompensationEventSubprocess` asks only whether the handler is a sub-process scope triggered by an event, never what tag the block it undoes carries.
- Neutral, because giving up a block undoes the finished work of every child inside it that carries an undo block, and reaches nothing around it.
  `CompensationUtil.collectCompensateEventSubscriptionsForScope` walks up from the cancel end and stops at the block itself, `createEventScopeExecution` registers the subscription when a child carrying an undo block completes, and `throwCompensationEvent` signals them newest first.
- Neutral, because the undo runs first and the escape path second, always in that order: `CancelEndEventActivityBehavior.execute` throws the compensation synchronously, and only its `doLeave` hands the run to the handler.
- Neutral, because `method` and `protocol` are reported on import and never written back, since `parseTransaction` reads no attribute of its own and the imported process runs exactly as the source document does.
- Bad, because one more ordinary English word, `attempt`, stops being available as an identifier anywhere in a file.

### Confirmation

`packages/language/test/` and `packages/transform/test/` pin both heads, both cancel positions, the placement rules, the two pairing warnings, the lowering, and the printed line.
Every import refusal is pinned by its error class, each one carrying wording of its own compared against the whole message rather than a substring of it; the exception is the cancel definition on a handler's start event, pinned by the event kind and the definition type the error records.
The frozen pair `tests/golden/transactions.{bpmnscript,bpmn}` nests the two heads inside each other each way round, hangs a cancel handler and an error handler on one block, and holds an ordinary block with an undo block of its own so a run that gives it up has finished work to undo; `tests/transactions.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/e2e/booking-attempt.test.ts` deploys to a real Operaton and drives it over REST: the declined run leaves through the handler and the seat held earlier goes back on sale, only the run that gave the block up records it as canceled, and the run that paid carries the booking past the block untouched.

## More Information

Related decisions: ADR-0012 (the honest import contract behind every refusal and every warning here).
ADR-0028 (the `on compensation` undo blocks a given-up block runs, reached here with no `throw compensation` written anywhere in the source).
