---
status: accepted
date: 2026-07-17
decision-makers: Marlon Kranz
---

# Derive Event Root Elements From Usage: Syntactic Throw Terminality, Soft Trigger Words

## Context and Problem Statement

BPMN keeps error and escalation definitions in two places. A `bpmn:Error` or
`bpmn:Escalation` root element sits under `bpmn:Definitions`, declared once per code and
carrying, for errors, the message text (`operaton:errorMessage`). Every start, end, or
intermediate-throw event that catches or throws that code carries its own
`errorEventDefinition`/`escalationEventDefinition`, referencing the root by id. Nothing
about *using* a code in an event definition is enough, by itself, to know it needs a root
element to exist — that bookkeeping sits one level up, in the document's root-element
list, disconnected from where the code is actually written.

The DSL's audience does not maintain BPMN documents by hand. Asking a user to declare a
root element before referencing its code from a handler, a throw, and a catch-all
elsewhere in the same process is exactly the kind of required syntax that carries no
process information of its own. At the same time, the event surface needs two properties
that BPMN's own vocabulary does not settle for a textual language: what makes a thrown
event end its path versus merely notify and continue, and whether the words naming event
kinds and catch-parameter fields need to be reserved to work at all.

This decision covers three related points that recur across the whole event layer: how
root elements come into existence, how `throw` and `emit` decide whether the flow
continues, and how the words spelling the event vocabulary are lexed and validated.

## Decision Drivers

- The target audience writes processes, not BPMN documents; syntax that exists only to
  declare what a compiler could already infer from usage does not pay for itself.
- BPMN lets an event definition reference no root at all — a catch-all. The surface must
  not force a code where the author wrote none, and must not synthesize a root element
  for a code that never resolves to one.
- The language round-trips: BPMN imported into DSL source and recompiled must reproduce
  the same document, so every derivation rule has to invert, and a printed statement must
  mean the same thing regardless of where it happens to sit in its enclosing block.
- Error and escalation are the first two event kinds; message, signal, timer, and
  conditional follow later. The design should not spend a keyword, or accumulate a
  root-element bookkeeping obligation, that later kinds would each need to repeat.

## Considered Options

- Derive root elements from usage, deduped by code, with the thrown-message text as one
  declared exception — versus a `Definitions`-level IR root that models root elements
  explicitly, and versus requiring an explicit declaration for every code
- Decide `throw`/`emit` terminality by keyword (a property of the word itself) — versus
  deciding it by statement position (last in a block compiles to an end event, anything
  else to an intermediate throw)
- Lex `error`, `escalation`, `code`, `message` as soft, validated identifiers — versus
  reserving them as keywords

## Decision Outcome

Chosen: derive root elements from usage instead of modeling them explicitly, with the
thrown-message text as the one piece of root data the IR stores because usage alone
cannot supply it; decide `throw`/`emit` terminality from the keyword rather than from
statement position; and lex trigger kinds and binding fields as validated identifiers
rather than keywords. All three keep BPMN's own bookkeeping — registries, event
definitions, reserved vocabulary — out of the author's hands wherever the compiler can
carry it instead, and spend required syntax only where the alternative breaks round-trip
fidelity or collides with the audience's own variable names.

**Root elements are derived, not modeled.** `irToXml` walks the whole IR once, collects
every distinct error and escalation code in use — on a catching start event, a throwing
end event, or an intermediate throw, anywhere in the document — and synthesizes one
`bpmn:Error` or `bpmn:Escalation` root per distinct code. Every event definition carrying
that code is wired to the same root through `errorRef`/`escalationRef`; a definition
without a code (catch-all) gets no ref and contributes no root, because BPMN itself
treats a ref-less catch as "any error" — there is nothing for it to point at. Root ids are
sanitized from the code and de-collided against the rest of the document; the root's
`name` is the code, verbatim.

The one exception is the message text an error carries when thrown.
`operaton:errorMessage` lives on the root, not on the throw statement, because two throw
sites sharing a code share one root, and the message cannot live at the throw site
without a mechanism to reconcile disagreeing copies. The surface exposes this as a
process-header declaration, `error "CODE" message "…"`, read into
`BpmnProcess.errorMessages` and stamped onto the synthesized root at export; import reads
the message back off the root. It is the one piece of root-element data the IR stores
explicitly, because it is the one property usage alone cannot determine — nothing about
*using* a code says what its message reads.

An imported document whose two roots share a code but disagree on the message is
refused, not merged: collapsing them would change what a throw carries at runtime, which
is the same reasoning ADR-0014 already applies to any drop that would alter execution
semantics.

**Throw and emit decide terminality by keyword, not position.** `throw error "C"` always
compiles to an end event; `emit escalation "C"` always compiles to an intermediate throw
that falls through to whatever follows it. The distinction lives in the keyword, not in
where the statement sits inside its block.

A single verb whose compiled form depends on being last in its block looks appealing —
one fewer keyword — but it does not survive the round trip. Take an IR shape the importer
must be able to reproduce: a branch that fires an escalation and rejoins the main flow,
`split → A → escalation-intermediate-throw → join`. Printed inside its branch block, that
statement is the last statement of the block — `{ A  <emit-form> "C" }` — simply because
the branch has nothing after it, not because the event ends anything. A position-decided
desugarer reads "last in block" and turns the statement back into an escalation *end*
event on the way in, which drops the join edge the original graph had. The same printed
text would then mean two different graphs depending on information the text itself does
not carry, which is exactly what round-trip fidelity rules out.

Deciding terminality from the keyword removes the ambiguity: `throw` always ends its path,
matching the intuition every reader already brings from exception handling in a
general-purpose language; `emit` always continues; and both escalation forms — end event
and intermediate throw — stay independently printable, which a document containing either
one must be able to reproduce regardless of where it sits.

`emit` is a general continuing verb, not an escalation-specific one. Error has no
continuing BPMN form — there is no intermediate error throw, so `emit error` is a
validator error — but escalation does, and later event kinds that fire and continue reuse
the same verb instead of growing their own. Giving every kind its own throw-and-continue
verb turns the surface into a vocabulary quiz; one shared verb keeps it small as kinds are
added.

**Trigger kinds and binding fields are validated identifiers, not keywords.** `on`,
`throw`, `emit`, and `alongside` are the only words this event layer reserves. `error`,
`escalation`, `code`, and `message` — the words that actually name the event kind and the
catch-parameter fields — lex as plain identifiers and are checked in position by the
validator instead.

The reason is the audience, not parsing convenience. `message` and `code` are two of the
most ordinary variable names in Java-style code, and reserving them would make
`var message: string` a parse error anywhere in a file, not only near an event handler. A
Langium keyword is lexer-global: there is no way to reserve a word only inside
`on`/`throw`/`emit` and leave it free everywhere else. Four permanent collisions on
exactly the words this audience reaches for is a worse trade than the validation work a
soft word costs.

What a keyword gives away for free — highlighting, completion, "did you mean" — is
rebuilt explicitly instead, each in the mechanism meant for it rather than a lexer trick:
a validator that checks `trigger`, `field`, and the declaration's `kind` against their
small legal sets and names the options directly in the diagnostic (each set has at most
two members, so "unknown event kind 'erorr'; write 'error' or 'escalation'" already is the
suggestion); a semantic-token provider that marks exactly the AST properties that carry
meaning, so `on error` highlights `error` while `var error` stays plain, a precision a
keyword-based or regex-based highlighter cannot reach; and completion items offered at
the same positions. This also pre-pays the next event kinds: `message`/`signal` become
validated trigger values later at zero additional reserved-word cost.

### Consequences

- Good, because using a code never requires declaring it first — a handler, a throw, and
  a catch-all can all reference the same code without any one of them being the "first"
  to establish it.
- Good, because every user of one code shares exactly one root element, so a code's
  message text has exactly one place to live, never several that could disagree.
- Good, because two disagreeing imports of the same code are refused rather than
  silently reconciled, keeping ADR-0014's "no silent semantic loss" claim intact for this
  construct too.
- Good, because `throw`/`emit` terminality is a property of the word printed, readable
  without looking at what follows in the block — and it matches the reading every reader
  already brings from exception handling elsewhere.
- Good, because the soft-word design costs zero additional reserved words when
  `message`/`signal` triggers are added later.
- Bad, because a catch-all definition contributes no root element to inspect, so a
  document consisting only of a catch-all handler for a code leaves nothing that names
  that code at the root-element level — correct, but there is no single element a tool
  can point to for "this code, however it's caught".
- Bad, because the soft-word design moves work from the grammar into four separate
  mechanisms — validator, semantic tokens, completion, parser-error messages — that all
  have to agree on the same two small word sets, instead of one keyword declaration
  doing it once.
- Bad, because a document whose two roots for one code disagree cannot be imported at
  all, even when the disagreement reads as cosmetic to a human ("Payment declined" versus
  "Payment was declined") — the importer has no way to tell a cosmetic disagreement from
  a meaningful one, so it refuses both alike.

### Confirmation

`packages/transform/test/ir-to-xml.test.ts` asserts the derivation directly: a document
using one code from a handler, a throw, and a catch-all handler produces exactly one root
element referenced by every coded use and none by the catch-all, with dedicated cases for
id sanitization and collision suffixing. `packages/transform/test/ast-to-ir.test.ts` and
`ir-to-dsl.test.ts` pin the branch-tail counterexample as a round-trip case: an
intermediate escalation throw as the last statement of a branch block prints as `emit`
and re-imports as the same intermediate throw, never an end event.
`packages/language/test/validating.test.ts` pins the soft-word behavior: `var message:
string`, `if (code == "x")`, and a task named `error` all parse and validate cleanly,
while an unrecognized trigger word or binding field produces the options-naming
diagnostic rather than a silent pass-through.

## Pros and Cons of the Options

### A `Definitions`-level IR root modeling `{ process, rootElements }` explicitly

Every event definition would reference an explicit IR-level root object instead of a
bare code string, and `astToIr`, `irToXml`, `irToDsl`, and `xmlToIr` would all thread it
through.

- Good, because it mirrors BPMN's own document structure exactly, leaving no derivation
  step that could get the mapping wrong.
- Bad, because every consumer signature changes — the CLI, all four transforms, every
  existing test — to carry data the DSL surface can never author independently in the
  first place; there is no syntax for "declare a root without using it" beyond the
  message declaration this decision already provides.
- Bad, because it reintroduces the registry-management burden this decision exists to
  avoid: something still has to create, id, and look up root objects, and that something
  is either the compiler (making the explicit IR-level model pure ceremony) or the
  author (reintroducing the boilerplate the derived design avoids).

### Explicit declarations for every code

Every error and escalation code would need a header declaration before use, generalizing
how the `error … message …` declaration already works for message text.

- Good, because it removes all derivation logic — a code is either declared or using it
  is a compile error, symmetrical and simple to check.
- Bad, because it demands decl-versus-usage redundancy for no expressive gain:
  dedup-by-code already makes usage-derived synthesis lossless for every property except
  the message text, which is precisely why that one property gets a declaration instead
  of the rule being generalized to all of them.

### Position-decided throw terminality

A single verb whose compiled form depends on whether a successor statement follows it in
the same block: last-in-block compiles to an end event, anything else to an intermediate
throw.

- Good, because it removes one keyword (`emit`) from the surface.
- Bad, because it is unsound under round-trip, per the branch-tail counterexample above:
  the same printed statement, in the same textual position, would have to mean two
  different graphs depending on information the printed text does not carry.

### Reserving trigger and field words as keywords

`error`, `escalation`, `code`, `message` become real keywords, parsed and highlighted
like `on`, `throw`, and `emit`.

- Good, because highlighting and completion come from the generated grammar and the
  parser's keyword table directly, with no additional provider code.
- Bad, because a Langium keyword is lexer-global: reserving `message` for the event
  surface reserves it everywhere, breaking `var message: string` anywhere in a file, on
  an audience for whom `message`, `code`, and `error` are ordinary variable names.

## More Information

Extended by ADR-0017 (message/signal/timer/conditional payloads) and ADR-0018
(compensation) — the later event kinds that reuse this decision's `throw`/`emit`
terminality rule and soft-word design without adding a reserved word.

Related decisions: ADR-0006 (the IR as the shared model — vendor- or serialization-only
data, like `operaton:historyTimeToLive`, attaches at the IR-to-XML boundary rather than
living in the IR; `errorMessages` is the one exception, and it is an exception because it
cannot be derived from usage, not because the boundary rule was relaxed). ADR-0010
(deterministic structural ids — synthesized root ids follow the same
sanitize-then-suffix collision rule as the existing structural-coordinate ids). ADR-0013
(the audience this design serves — no BPMN-document bookkeeping, no required syntax the
compiler could supply itself). ADR-0014 (the honest import contract — disagreeing root
definitions for one code are refused rather than merged, for the same reason a
semantically significant drop is refused rather than warned). ADR-0001 and ADR-0002 (VS
Code and Langium as the IDE target and workbench — the reason the soft-word design
rebuilds highlighting and completion as explicit language-server providers rather than
through the keyword table).
