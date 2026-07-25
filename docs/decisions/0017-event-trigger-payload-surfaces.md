---
status: accepted
date: 2026-07-18
decision-makers: Marlon Kranz
---

# Event Trigger Payloads: One Paren Slot, Validated Timer Particles, Deferred Conditional Narrowing, Name-Keyed Roots

## Context and Problem Statement

The event layer's `on` handler already hosts two trigger kinds, error and escalation, sharing one payload shape: an optional code string and an optional parenthesized binding list.
Four more trigger kinds join the same `on` surface, message, signal, timer, and conditional, and between them they need three payload shapes the existing rule does not have.
Message and signal carry a name string, structurally identical to error/escalation's code.
Timer carries something different: a word choosing which of BPMN's three timer forms applies, followed by a time expression.
Conditional carries a boolean expression, which wants the same parenthesized slot error/escalation already use for bindings, but for an unrelated purpose: a condition, not a catch parameter.

Fitting three payload shapes into one handler surface, without forking `on` into a separate grammar rule per trigger kind and without reserving a new keyword for each shape, is the central question this decision resolves.
Two narrower questions ride along with it: how a timer's payload text becomes one of BPMN's three timer definition kinds without silently picking the wrong one, and how much of BPMN's conditional-evaluation narrowing the surface should expose given that the DSL's audience has no reason to know it exists.

## Decision Drivers

- One `on` handler surface has to host all six trigger kinds without forking into six grammar rules or growing a reserved word for every new payload shape.
  The soft-word design already in place for trigger names should not be reopened to make room for new payloads.
- A condition is a real expression, not a string.
  It needs the same round-trip and variable-participation guarantees the language's `if` conditions already have, not a demotion to opaque text that a validator, a symbol table, or a highlighter cannot see inside.
- A timer's payload must resolve to exactly one of BPMN's three time-definition kinds.
  Because a wrong resolution changes what the engine schedules, not just how the text reads, guessing the kind from the value's shape is a real correctness risk, not a cosmetic one.
- Message and signal need something for the engine to key its subscriptions on, and BPMN keeps that identity in root elements the same way it already does for error and escalation codes.
  Whatever the surface settles on must not reintroduce the declare-before-use boilerplate the language otherwise avoids.
- Camunda's conditional-evaluation narrowing attributes change when a condition is checked.
  If the surface cannot express them, silently dropping them on import would be a behavior change disguised as a cosmetic loss.

## Considered Options

For the parenthesized slot:

- One paren slot holding either a binding list or a condition, disambiguated structurally
- A binding-marker keyword freeing the parens for bindings only
- A string-wrapped condition
- Reserving `condition` as a keyword to dispatch the parens

For timer forms:

- Timer particles (`after`/`at`/`every`) as validated identifiers mapping one-to-one to BPMN's three timer forms
- A single particle with the timer form inferred from the value's shape

For conditional narrowing:

- Defer the attributes and refuse them on import rather than drop them
- Surface them as a fourth payload shape
- Drop them silently on import

For message and signal roots:

- Derive them from usage, keyed by name, with no declaration form
- An explicit root declaration, mirroring the error message declaration

## Decision Outcome

Four related decisions, chosen together because each keeps the same principle: spend a new payload shape or a new reserved word only where the alternative loses something the surface cannot get back, whether round-trip fidelity, execution-accurate scheduling, or truthful runtime semantics, and nowhere else.

One paren slot, disambiguated structurally.
The parentheses after a trigger's code stay a single grammar position that holds either a binding list or a condition expression.
Which one is present is decided structurally, not by which trigger word precedes it: a binding list is a field name followed by a variable name, two identifiers in a row, and the expression sub-language never places two identifiers adjacently, since every accessor starts with `.` or `[` and every operator level requires an operator token in between.
The parser tells the two apart by looking at the second token after the opening parenthesis, which settles it before any per-trigger legality is even considered.
Whether a given trigger is allowed to use bindings, a condition, or neither is exactly the kind of position rule the validator already owns for every other soft word.

Rejected: a binding-marker keyword, freeing the bare parentheses for a condition by writing bindings after a marker such as `as (...)`.
It spends a new reserved word to solve a collision that structural lookahead already dissolves for free, and it breaks the parameter-list reading (`on error "X" (code c, message m)`, read like `catch (Exception e)`) that motivated the binding shape in the first place.
Rejected: a string-wrapped condition, written as a quoted literal instead of a real expression.
It reads worse than the language's own `if (...)`, and it throws away everything a real expression AST buys, including undeclared-variable checking, type checking, symbol participation, and precise highlighting, turning the condition into opaque text the rest of the toolchain cannot see inside.
Rejected: reserving `condition` as a keyword to dispatch the parens explicitly.
Reserving it would make it a lexer-global reservation, unusable as an ordinary variable name anywhere in a file, for exactly the reason the trigger and binding words already stay soft identifiers rather than keywords.

Timer particles are validated identifiers, one-to-one, with no inference.
A timer's payload is a particle word, `after`, `at`, or `every`, followed by a time expression.
Each particle maps to exactly one of BPMN's timer forms: a duration, a fixed date, or a repeating cycle.
The particle is a plain identifier, checked in position by the validator like every other soft trigger word, not a keyword.

Rejected: a single particle whose timer form is inferred from the shape of the time value itself, where an ISO date looks like a date and a duration string looks like a duration.
This shifts a scheduling decision onto pattern-matching the value's text, and a value that happens to be malformed, whether a mistyped ISO string or an expression the engine evaluates at runtime rather than a literal the compiler can inspect, silently becomes a different timer kind than the one the author meant, with no diagnostic pointing at the mismatch.
Three explicit particles read as the English they mean, "after an hour," "at nine," "every ten minutes," and cannot silently resolve to the wrong form.

Conditional narrowing is deferred, and refused rather than dropped on import.
BPMN's conditional event definition can additionally narrow when a condition is re-evaluated, to a named variable or a specific kind of variable change, rather than re-checking on every change.
This narrowing is an optional, engine-side evaluation optimization: a handler behaves correctly without it, re-checking on any variable change instead of a specific one.
The surface does not expose it, because the audience writing BPMNscript has no reason to know Camunda's evaluation-narrowing mechanism exists, and giving it a place on the `on condition` payload would mean a fourth, narrower payload shape carrying nothing but an optimization hint.

Because the narrowing attributes change when the engine re-checks a condition, they are runtime semantics, not cosmetic metadata.
Importing a document that carries them therefore refuses rather than silently dropping them: dropping a narrowing hint would leave the imported process re-checking its condition on every variable change instead of the one the original author scoped it to, which is exactly the kind of silent behavior change the honest import contract exists to prevent.
The refusal names the attribute so a future surface has somewhere to land it, rather than pretending the information never existed.

Message and signal roots are derived from usage, keyed by name, with no declaration form.
A message or signal root carries exactly one piece of information the engine cares about: its name, which is also the identity the engine keys its subscriptions and correlations on.
Because the name is both the only data and the natural key, the root is fully derivable from wherever the name is used, whether a handler, a throw, or an emit, with no separate declaration form and no new field on the process's structure.
Every use of the same name, anywhere in the document, resolves to the same root.

This differs from the error root's message-text declaration.
An error's thrown message is per-code data that usage alone cannot supply, since two throw sites sharing a code might disagree on wording, so it has exactly one declared place to live.
Message and signal have no equivalent, because nothing about a name's use is ambiguous or needs reconciling, so no declaration form is introduced for them.

Rejected: an explicit root declaration mirroring the error message declaration.
It would generalize a mechanism that exists only because the error message text has no other source, to two triggers for which usage already supplies every property in full, which is pure boilerplate with no expressive gain.

### Consequences

- Good, because none of the four decisions spends a new reserved word: message, signal, timer, and conditional slot into the existing soft-word and paren machinery at zero reservation cost, the same guarantee the error/escalation design already made for the trigger set as a whole.
- Good, because one verb pair, `throw` and `emit`, continues to span every trigger kind that has a throw form at all.
  Signal joins error and escalation under the same rule instead of growing its own vocabulary, so the reader who has learned the rule once for error and escalation does not have to relearn it for signal.
- Good, because the condition payload stays a real, checkable expression rather than an opaque string, so a condition handler gets the same variable checking, symbol participation, and highlighting an `if` statement already gets.
- Bad, because a document carrying the conditional narrowing attributes cannot be imported at all, even though the underlying evaluation difference is invisible to a reader who does not already know Camunda's narrowing mechanism exists.
  The refusal is correct but reads as stricter than the visible difference suggests.
- Bad, because timer's three particles are one more small vocabulary to learn than a single particle would have been, paid once in exchange for a scheduling decision that cannot silently resolve to the wrong timer kind.

## More Information

Extended by ADR-0018 (compensation), the one trigger kind whose payload is empty, slotting into the same `on`/`throw`/`emit` surface this decision shapes without a new reserved word.

Related decisions: ADR-0013 (the target audience and the no-boilerplate rule, the reason message and signal get no declaration form, and the reason the conditional narrowing attributes stay off the surface until an author actually needs them).
ADR-0014 (the honest import contract, the reason conditional narrowing attributes are refused on import rather than dropped, and the model this decision follows for treating a semantics-bearing drop as a refusal).
ADR-0016 (the derived error/escalation root design and the `throw`/`emit` verb pair, which this decision extends to message and signal, and against which it contrasts the error message declaration with message/signal's lack of one).
