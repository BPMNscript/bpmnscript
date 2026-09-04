---
status: accepted
date: 2026-08-31
decision-makers: Marlon Kranz
---

# Work That Can Be Given Up: the `attempt` Block and the `cancel` Trigger

## Context and Problem Statement

BPMN has a container for work that is abandoned as a unit: a `bpmn:transaction`, given up by an end event inside it carrying a `bpmn:cancelEventDefinition`, caught by a boundary event of the same kind.
Operaton rejects either cancel position outside such a container, so neither is expressible until the container is.
This grammar had no container to put them in, so any document carrying the element refused on import and the round trip stopped there.
What does the container head say, where may a cancel sit, and which shapes does the surface decline to carry?

## Decision Drivers

- ADR-0013 binds a keyword to what the author means rather than to the BPMN element behind it.
- ADR-0014 refuses what changes the run and warns only about drops that do not.
- A Langium statement keyword is lexer-global, so a word spent on a head is a name lost everywhere in a file.
- Operaton decides what deploys here, and a surface stricter than the engine owes a reason.

## Considered Options

- `attempt` as a second head on the existing sub-process rule
- `transaction` as the head, the BPMN element name
- A settings key on an ordinary block, `subprocess X { transaction = true }`
- A grammar rule of its own, with the second AST type that comes with it
- `cancel` carried on the `end` statement the way `terminate` is, against `throw cancel`
- A host-less `on cancel` handler
- A cancel end with no handler refused on import
- A non-interrupting cancel handler imported as an interrupting one

## Decision Outcome

Chosen options: `attempt` on the existing rule, `cancel` on the `end` statement, no host-less handler, the missing handler warned, and the non-interrupting handler refused.

A block reads `attempt BookAndPay { ... }`, `end BookingAbandoned cancel` inside it gives that block up, and `on BookAndPay: cancel { ... }` catches it.

`transaction` loses twice over.
It is the BPMN element name, the one thing ADR-0013 rules out.
It also promises what the engine does not deliver: Operaton's `BpmnParse.parseTransaction` installs the same `SubProcessActivityBehavior` that `parseSubProcess` installs for an ordinary block.
Nothing is atomic and no transaction protocol runs: the tag buys the engine's acceptance of the two cancel positions, and nothing rolls back except what the author's own undo blocks reverse.
`attempt` says what the author means, which is to run this block of work and, if it is given up, undo what it finished.

A settings key fails the same test `sequential = true` failed in ADR-0027, since a boolean named after the element is that element wearing a DSL hat.
A rule of its own loses on cost: the AST node stays `SubProcess`, so the scope provider, the linker, and every rule keyed on a sub-process reach the new head untouched.
`attempt` is a hard keyword, so the name is lost everywhere in a file, while `cancel` stays a soft word that still lexes as an ordinary identifier.

`cancel` is one word in both positions, which keeps the raise and the catch out of two vocabularies for one event.
It rides the `end` statement rather than `throw`, because it carries no code, always ends its path, and BPMN raises a cancel from an end event only.
`throw cancel` and `emit cancel` draw a diagnostic naming the right spelling instead.
A host-less handler lowers to an event sub-process, and Operaton's `parseScopeStartEvent` fails the deployment of one whose start event carries a cancel definition, so the surface rejects it too.

Four shapes refuse on import, each because Operaton itself rejects the deployment: a cancel end outside such a block, a cancel handler on any other host, a second handler on one block, and the cancel definition on the host-less handler's start event named above.
`parseEndEvents` accepts a cancel end only where the container holding it is a transaction, so a branch inside the block is still inside it and a nested block is not.
The two boundary shapes are consecutive checks in `parseBoundaryCancelEventDefinition`.
A `cancelActivity="false"` handler refuses although the parser accepts it: `parseBoundaryEvents` gives it `ActivityStartBehavior.CONCURRENT_IN_FLOW_SCOPE`, and importing it as interrupting would change the run.

A cancel end whose block carries no handler warns instead, on both sides.
Parsing the handler is what wires the pair, since `parseBoundaryCancelEventDefinition` calls `setCancelBoundaryEvent` on every `CancelEndEventActivityBehavior` among the block's direct children.
With no handler that reference stays null, and `CancelEndEventActivityBehavior.execute` opens on an `EnsureUtil.ensureNotNull` for it.
Taking the handler out of the booking example shows both halves: the document deploys, and the first run stops with "Could not find cancel boundary event for cancel end event Activity(BookingAbandoned): cancelBoundaryEvent is null".
Refusing would reject a document the engine accepts, which the import contract does not license, so both sides warn and name that runtime failure.
A handler on a block whose body holds no cancel end warns for the same reason, since only a cancel end hands the run to it, through `CancelEndEventActivityBehavior.doLeave`.

### Consequences

- Good, because a document the engine runs as work that can be given up now imports, prints, and recompiles byte for byte, where before it stopped the import at the container.
- Neutral, because giving up a block undoes the finished work of every child inside it that carries an undo block, and reaches nothing around it.
  `CompensationUtil.collectCompensateEventSubscriptionsForScope` walks up from the cancel end and stops at the block itself, so no scope outside it is collected.
  `createEventScopeExecution` registers the subscription when a child carrying an undo block completes, and `throwCompensationEvent` signals them newest first.
- Neutral, because the undo runs first and the escape path second, always in that order.
  `CancelEndEventActivityBehavior.execute` throws the compensation synchronously, and only its `doLeave` hands the run to the handler.
- Good, because a block written with the new head and carrying no cancel anywhere is an ordinary block of work to the engine, which is what lets an imported transaction round-trip unchanged.
- Good, because such a block may carry its own `on compensation`, so an enclosing scope can undo it in turn.
  Operaton's `hasCompensationEventSubprocess` asks only whether the handler is a sub-process scope triggered by an event, never what tag the block it undoes carries.
- Neutral, because `method` and `protocol` are reported on import and never written back, since `parseTransaction` reads no attribute of its own and the imported process runs exactly as the source document does.
- Bad, because one more ordinary English word stops being available as an identifier anywhere in a file.

### Confirmation

`packages/language/test/` and `packages/transform/test/` pin both heads, both cancel positions, the placement rules, the two pairing warnings, the lowering, and the printed line.
Every import refusal is pinned by its error class, and each one carrying wording of its own is compared against the whole message rather than a substring of it.
The exception is a cancel definition on a handler's start event, pinned by the event kind and the definition type the error records.
The frozen pair `tests/golden/transactions.{bpmnscript,bpmn}` nests the two heads inside each other each way round and hangs a cancel handler and an error handler on one block.
That block holds an ordinary block with an undo block of its own, so a run that gives it up has finished work to undo.
`tests/transactions.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/e2e/booking-attempt.test.ts` deploys to a real Operaton and drives it over REST, where the declined run leaves through the handler and the seat held earlier goes back on sale.
Only the run that gave the block up records it as canceled, and the run that paid carries the booking past the block untouched.

## Pros and Cons of the Options

### `attempt` as a second head on the existing sub-process rule

- Good, because the word names the intent rather than the tag, which is the test ADR-0013 sets.
- Good, because it costs no AST type and no branch in anything that already asks whether a statement is a sub-process.

### `transaction` as the head

- Bad, because it is the BPMN element name and promises a rollback the engine never performs, so a reader learns the wrong thing twice.

### A host-less `on cancel` handler

- Bad, because it lowers to an event sub-process whose start event Operaton refuses to deploy, and BPMN has nothing that opens on a cancel.

## More Information

Related decisions: ADR-0013 (the rule that a keyword names what the author means, and the reason `transaction` is not one).
ADR-0014 (the honest import contract behind every refusal and every warning here).
ADR-0018 (the `on compensation` undo blocks that a given-up block runs, reached here with no `throw compensation` written anywhere in the source).
ADR-0019 (the boundary attachment this decision extends with one trigger on one host kind).
ADR-0020 (the intermediate catch that keeps cancel out of its four-trigger scope, whose two BPMN-legal positions this decision surfaces instead).
