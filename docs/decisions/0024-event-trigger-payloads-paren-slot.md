---
status: accepted
date: 2026-07-18
decision-makers: Marlon Kranz
---

# Event trigger payloads in one paren slot

## Context and Problem Statement

The event layer's `on` handler already hosts two trigger kinds, error and escalation, sharing one payload shape: an optional code string and an optional parenthesized binding list.
Four more trigger kinds join the same `on` surface, message, signal, timer, and conditional, and between them they need three payload shapes the existing rule does not have.
Message and signal carry a name string, structurally identical to error/escalation's code.
Timer carries something different: a word choosing which of BPMN's three timer forms applies, followed by a time expression.
Conditional carries a boolean expression, which wants the same parenthesized slot error/escalation already use for bindings, but for an unrelated purpose: a condition, not a catch parameter.

Fitting three payload shapes into one handler surface, without forking `on` into a separate grammar rule per trigger kind and without reserving a new keyword for each shape, is the central question this decision resolves.
Two narrower questions ride along with it: how a timer's payload text becomes one of BPMN's three timer definition kinds without silently picking the wrong one, and how much of BPMN's conditional-evaluation narrowing the surface should expose given that the DSL's audience has no reason to know it exists.

## Decision Drivers

- One `on` handler surface has to host all six trigger kinds without forking into six grammar rules or growing a reserved word for every new payload shape, and the soft-word design already in place for trigger names should not be reopened to make room for new payloads.
- A condition is a real expression, not a string.
  It needs the same round-trip and variable-participation guarantees the language's `if` conditions already have, not a demotion to opaque text that a validator, a symbol table, or a highlighter cannot see inside.
- A timer's payload must resolve to exactly one of BPMN's three time-definition kinds.
  Because a wrong resolution changes what the engine schedules, not just how the text reads, guessing the kind from the value's shape is a real correctness risk, not a cosmetic one.
- Message and signal need something for the engine to key its subscriptions on, and BPMN keeps that identity in root elements the same way it already does for error and escalation codes, so whatever the surface settles on must not reintroduce the declare-before-use boilerplate the language otherwise avoids.
- Camunda's conditional-evaluation narrowing attributes change when a condition is checked, so a surface that cannot express them would turn a silent drop on import into a behavior change.

## Considered Options

- One paren slot holding either a binding list or a condition, disambiguated structurally, which needs no new word and keeps the parameter-list reading the binding shape was built for.
- A binding-marker keyword freeing the parens for bindings only, writing them after a marker such as `as (...)`, which spends a new reserved word on a collision structural lookahead already dissolves for free and breaks the parameter-list reading (`on error(X, code: c, message: m)`, read like `catch (Exception e)`) that motivated the binding shape in the first place.
- A string-wrapped condition, written as a quoted literal instead of a real expression, which reads worse than the language's own `if (...)` and throws away everything a real expression AST buys, including undeclared-variable checking, type checking, symbol participation, and precise highlighting.
- Reserving `condition` as a keyword to dispatch the parens, which would be a lexer-global reservation, unusable as an ordinary variable name anywhere in a file, for exactly the reason the trigger and binding words already stay soft identifiers.
- Timer particles, `after`, `at` and `every`, as validated identifiers mapping one-to-one to BPMN's three timer forms, which read as the English they mean and cannot silently resolve to the wrong form.
- A single particle with the timer form inferred from the value's shape, where an ISO date looks like a date and a duration string looks like a duration, which shifts a scheduling decision onto pattern-matching the value's text: a mistyped ISO string, or an expression the engine evaluates at runtime rather than a literal the compiler can inspect, becomes a different timer kind than the one the author meant, with no diagnostic pointing at the mismatch.
- Deferring the conditional narrowing attributes and refusing them on import rather than dropping them.
- Surfacing them as a fourth payload shape, narrower than the other three and carrying nothing but an engine-side optimization hint the audience has no reason to know about.
- Dropping them silently on import, which would leave the imported process re-checking its condition on every variable change instead of the one the original author scoped it to.
- Message and signal roots derived from usage, keyed by name, with no declaration form, since the name is both the root's only data and its key.
- An explicit root declaration mirroring the error message declaration, which generalizes a mechanism that exists only because the error message text has no other source to two triggers for which usage already supplies every property in full.

## Decision Outcome

Chosen: one paren slot disambiguated structurally, timer particles mapping one-to-one with no inference, conditional narrowing deferred and refused rather than dropped, and message and signal roots derived from usage.
Each keeps the same principle: spend a new payload shape or a new reserved word only where the alternative loses something the surface cannot get back, whether round-trip fidelity, execution-accurate scheduling, or truthful runtime semantics, and nowhere else.

The parentheses after a trigger's code stay a single grammar position that holds either a binding list or a condition expression, and which one is present is decided structurally, not by which trigger word precedes it.
A binding list is a field name followed by a variable name, two identifiers in a row, and the expression sub-language never places two identifiers adjacently, since every accessor starts with `.` or `[` and every operator level requires an operator token in between.
The parser therefore tells the two apart by looking at the second token after the opening parenthesis, which settles it before any per-trigger legality is considered, and whether a given trigger may use bindings, a condition, or neither is the kind of position rule the validator already owns for every other soft word.

A timer's payload is a particle word followed by a time expression, each particle mapping to exactly one of BPMN's timer forms, a duration, a fixed date, or a repeating cycle.
The particle is a plain identifier, checked in position by the validator like every other soft trigger word, not a keyword.

BPMN's conditional event definition can additionally narrow when a condition is re-evaluated, to a named variable or a specific kind of variable change, rather than re-checking on every change.
This narrowing is an optional, engine-side evaluation optimization: a handler behaves correctly without it, re-checking on any variable change instead of a specific one, so the surface does not expose it.
Because the attributes change when the engine re-checks a condition, they are runtime semantics rather than cosmetic metadata, so importing a document that carries them refuses rather than dropping them, and the refusal names the attribute so a future surface has somewhere to land it.

A message or signal root carries exactly one piece of information the engine cares about: its name, which is also the identity the engine keys its subscriptions and correlations on.
Because the name is both the only data and the natural key, the root is fully derivable from wherever the name is used, whether a handler, a throw, or an emit, with no separate declaration form and no new field on the process's structure, and every use of the same name anywhere in the document resolves to the same root.
This differs from the error and escalation declarations ADR-0023 settles: a code is declared in the process header and named at each of its sites, which gives it a cross-reference and gives its thrown message one place to live, since two throw sites sharing a code might disagree on wording.
A message or signal name has neither need, so no declaration form is introduced for one, and ADR-0023's tooling argument would apply to a message and a signal name too, which is a decision of its own and is not taken here.

### Consequences

- Good, because none of the four decisions spends a new reserved word: message, signal, timer, and conditional slot into the existing soft-word and paren machinery at zero reservation cost, the same guarantee the error/escalation design already made for the trigger set as a whole.
- Good, because one verb pair, `throw` and `emit`, continues to span every trigger kind that has a throw form at all.
  Signal joins error and escalation under the same rule instead of growing its own vocabulary, so the reader who has learned the rule once for error and escalation does not have to relearn it for signal.
- Good, because the condition payload stays a real, checkable expression rather than an opaque string, so a condition handler gets the same variable checking, symbol participation, and highlighting an `if` statement already gets.
- Bad, because a document carrying the conditional narrowing attributes cannot be imported at all, even though the underlying evaluation difference is invisible to a reader who does not already know Camunda's narrowing mechanism exists.
  The refusal is correct but reads as stricter than the visible difference suggests.
- Bad, because timer's three particles are one more small vocabulary to learn than a single particle would have been, paid once in exchange for a scheduling decision that cannot silently resolve to the wrong timer kind.
