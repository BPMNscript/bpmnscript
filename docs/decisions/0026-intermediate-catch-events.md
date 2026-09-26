---
status: accepted
date: 2026-07-24
decision-makers: Marlon Kranz
---

# Intermediate catch events

## Context and Problem Statement

An `on` handler is a racing scope guard, compiling to an event sub-process that competes with the whole container it guards, and `throw` and `emit` go the other way, making the current path fire a trigger outward.
Neither covers `bpmn:intermediateCatchEvent`, a node sitting on the main sequence flow where the token stops in place until the trigger fires and then carries on to whatever follows.
Three questions settle together: what word introduces it, given that trigger words and timer particles are soft identifiers so only token position can disambiguate; whether it carries an author-chosen name; and which of BPMN's catchable event kinds this attachment point exposes.

## Decision Drivers

- Every trigger word and every timer particle is a soft identifier (ADR-0023), so a rule sharing that vocabulary has to be run through the parser generator and shown clean, not merely look plausible.
- The payload surfaces for message, signal, timer, and conditional triggers (ADR-0024) are already reused by `on` handlers and boundary events, so a third consumer should cost one dispatch case per layer rather than a second payload grammar.
- The restructuring analysis and the round-trip id normalizer have settled rules for what needs special handling, and a new construct should fit them rather than add an exception to either.
- An unsupported form on the wire is refused with a diagnostic naming what was refused, never dropped or approximated (ADR-0012).

## Considered Options

- `await`, which carries the meaning all four cases share, that execution stops here until this specific thing resolves, and is the word this audience already reads that way in mainstream asynchronous code.
- `wait`, which reads as a generic pause, closer to a fixed delay than to a subscription that resolves when something happens.
- `receive`, which names precisely what a message catch does and mislabels the other three: a signal is broadcast rather than addressed to anyone, a timer is not received from anywhere, and a condition is evaluated rather than delivered.
- An optional `name=ID` slot ahead of the trigger word, mirroring how a hosted `on` handler is named.
- Message, timer, signal, and conditional as the trigger scope, exactly the shapes the shared `readCatchEventDefinition` helper maps, the same function an `on` handler's start event and a boundary event's catch side both read through.
- Every BPMN catchable trigger, adding error, escalation, compensation, and cancel, which would need no exclusion list and no refusal diagnostics.

## Decision Outcome

Chosen options: `await`, a name that follows the trigger word rather than preceding it, and a scope of message, timer, signal, and conditional.
Link joins that scope for the import direction (ADR-0030).

Before committing to the keyword, the rule was built into a live Langium parser with Chevrotain's self-analysis switched on (`createServicesForGrammar`) and the full trigger-payload battery was run through it.
Every form parsed with zero ambiguity warnings, including the case that matters: `await timer("PT1H")`, a bare identifier followed by a parenthesized payload, resolved to `trigger='timer'` with the duration as its payload.
`wait` and `receive` parse exactly as cleanly, so the choice between the three is not a parsing question.
Reserving `await` collides with no trigger word or timer particle in the grammar, and it appears as a bare identifier nowhere in the committed corpus, unlike `message` or `code`, which stay soft precisely because they are ordinary variable names.

A trial grammar carrying the name ahead of the trigger was run through the same live-parser check and reported "Ambiguous Alternatives Detected inside IntermediateCatchEvent Rule": with a name and a trigger both bare identifiers, nothing decides which of the two the first word after `await` is.
That is not a cosmetic misparse.
A bare payload, an `at` key, and an `every` key map to a duration, a fixed date, and a repeating cycle, three different things the engine schedules, so a timer read as a name loses which one the author wrote.
The name therefore follows the trigger word, in the position `emit` already spells one.

The four triggers are the only kinds this language treats as something a token can genuinely wait on.
Error and escalation are always thrown by `throw` or `emit` and always reacted to by a racing `on` handler, so letting `await` claim them would leave two constructs both plausibly catching the same trigger with no rule for which one fires.
Compensation has one meaning here, the undo block a subprocess declares with `on compensation` (ADR-0028), invoked by the engine's own compensation machinery and never something with an independent arrival.
BPMN gives cancel no position an `await` could occupy: a transaction sub-process's boundary catches one and an end event inside that sub-process raises it, and ADR-0029 surfaces that container as the `attempt` block with both of those positions.

On import, an excluded definition, or more than one definition on the same element, is refused by name.
The XML schema does not stop a document from placing one of those on an intermediate catch element, so the refusal is a real check against input a foreign tool or a hand-edited file can produce.
The catch is the topological twin of `IntermediateThrowEvent`, `emit`'s compiled form, differing only in whether the token fires forward immediately or stops and waits, so the restructuring analysis reads it as an ordinary node with a normal immediate dominator and the round-trip id normalizer re-keys nothing.

### Consequences

- Good, because the full payload battery parses with zero ambiguity warnings, so `await` reserves one word and touches no existing rule's disambiguation.
- Good, because `await` names exactly the behavior all four triggers share rather than a word accurate for one of them and approximate for the rest.
- Good, because the catch is a topological twin of the intermediate throw, so forward emit, decompile, the restructuring analysis, and the round-trip normalizer each reuse existing machinery through one dispatch case.
- Good, because the trigger scope matches `readCatchEventDefinition` exactly, so import gains an honest refusal for the forms it cannot represent instead of a blanket refusal or a silent drop.
- Bad, because error, escalation, compensation, and cancel stay permanently unreachable from `await`, even on a hand-crafted document where the shape looks unremarkable to a reader who does not know BPMN restricts a plain intermediate catch element to a smaller set than a boundary event or an event sub-process's start accepts.

### Confirmation

`packages/language/test/` pins each trigger's parse, the timer case pinning that which of its three forms was written survives, that `var await` fails to parse while `var message: string` and a step named `every` still parse clean, and each rejected trigger word by its whole message.
`packages/transform/test/` pins the lowering, the emitted `*EventDefinition` shapes, the mapped shapes and the refusals, the decompiled render lines, the synthesized id, and the control-flow no-op as an explicit regression case: a catch on the main flow gets a normal immediate dominator, never the virtual entry.
`tests/golden/intermediate-catch.bpmn` and its round-trip suite exercise all four triggers across a full DSL -> XML -> IR -> DSL cycle, and a Docker-gated end-to-end test correlates a message mid-flow to show the instance genuinely waiting before correlation and completing after, the one property no other layer can show.
