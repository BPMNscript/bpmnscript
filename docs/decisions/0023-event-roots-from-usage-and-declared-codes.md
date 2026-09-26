---
status: accepted
date: 2026-07-17
decision-makers: Marlon Kranz
---

# Event root elements derived from usage, and declared codes

## Context and Problem Statement

BPMN keeps an error or an escalation in two places.
A `bpmn:Error` or `bpmn:Escalation` root element sits under `bpmn:Definitions`, one per code, carrying for errors the message text (`operaton:errorMessage`).
Every start, end, or intermediate-throw event that catches or raises that code carries its own `errorEventDefinition` or `escalationEventDefinition` and references the root by id.
Nothing about using a code in an event definition says that a root has to exist, so the bookkeeping sits one level up, in the document's root-element list, away from where the code is written.

The audience writes processes, not BPMN documents, so that list is not theirs to maintain.
A code still needs an identity the editor can address.
A site that raises a code and a site that catches it are otherwise two string literals that happen to match, so there is nothing to jump to, nothing to rename, and a typo is a second code rather than a mistake.

Two further properties of the event surface are ones BPMN's own vocabulary does not settle for a textual language.
What makes a raised event end its path rather than notify and continue, and whether the words naming event kinds and catch-parameter fields have to be reserved in order to work.

## Decision Drivers

- Jump-to-definition, find-references, rename and completion are the contribution a textual DSL makes over a graphical editor, and a payload the language server cannot resolve is where that contribution stops.
- A mistyped code has to be a diagnostic at the site that wrote it, rather than a second code the export writes a root for.
- BPMN lets an event definition reference no root at all, a catch-all, so the surface must not force a code where the author wrote none and must not synthesize a root for a code that never resolves to one.
- The round trip is byte-exact against frozen artifacts, so import has to reproduce the codes a document arrives with, including a code no identifier can spell and a root nothing raises, and a printed statement has to mean the same thing wherever it sits in its block.
- Whatever resolves a code has to leave every other identifier alone.
  A bare word in `condition(ready)` or in `if (amount > 100)` is a variable, and the undeclared-variable warning is the diagnostic its author needs.
- Error and escalation are the first two event kinds, with message, signal, timer and conditional behind them, so the design should not spend a keyword, or accumulate a root-element obligation, that each later kind repeats.
- Every element is spelled `verb Id(settings)`, so a declaration with a shape of its own would be the one construct left over.

## Considered Options

- Root elements derived from usage, deduped by code, so nothing about the document's root-element list reaches the author.
- A `Definitions`-level IR root modeling `{ process, rootElements }` explicitly, which mirrors BPMN's own document structure with no derivation step to get wrong, but changes every consumer signature, the CLI, all four transforms and every existing test, to carry data the declaration already supplies, and still leaves something to create, id and look up root objects: the compiler, making the explicit model ceremony, or the author, reintroducing the registry management this decision exists to avoid.
- A declaration in the process header that every use site references by a bare name, which gives a code a definition to jump to and one home for its message text.
- No declaration, with the validator checking each site against the set of codes it collects from the document, which needs no scope provider, no linker wording and no filtering of link failures, and keeps a bare word a bare word to the rest of the toolchain, but produces a diagnostic and nothing else, where the editor features that motivate the design read the reference graph.
- A quoted code at every use site, so a code used once costs one site and no more, but a string literal is invisible to the language server, so the editor features have no reference to read and a typo becomes a second code the export writes a root for.
- A cross-reference alternative of its own in the shared paren rule, which would put the distinction in the grammar where a reader would find it in one place, but does not parse: `error(OUT_OF_STOCK)` and `condition(ready)` are the same tokens in the same position, and the arm made Chevrotain report `AMBIGUOUS_ALTERNATIVES` and resolve the ambiguity by parsing the condition as a reference.
- The reference on `VarRef`, the rule every identifier in an expression already builds, with the two readings of a bare word separated by scope.
- `throw error(...)` as the only spelling for raising an error.
- A second spelling on the end statement, `end Finished error(...)`, beside the `terminate` and `cancel` an `end` already carries, which would keep a labeled error end its caption, since `end` carries a label and `throw` does not, but makes one IR shape carry two printed forms the printer has to choose between.
- Terminality decided by the keyword, as a property of the word itself.
- Terminality decided by statement position, last in a block compiling to an end event and anything else to an intermediate throw, which removes the `emit` keyword but is unsound under round trip.
- `error`, `escalation`, `code` and `message` lexed as soft, validated identifiers.
- The same four reserved as keywords, which would draw highlighting and completion from the generated grammar and the parser's keyword table with no provider code, but a Langium keyword is lexer-global, so reserving `message` for the event surface reserves it everywhere and breaks `var message: string` anywhere in a file, on an audience for whom `message`, `code` and `error` are ordinary variable names.

## Decision Outcome

Chosen: root elements derived from usage rather than modeled explicitly, a declaration in the process header that every use site references by a bare name, the reference carried on `VarRef` with the two readings of a bare word separated by scope, terminality decided by the keyword rather than by statement position, and trigger kinds and binding fields lexed as validated identifiers rather than keywords.
Each keeps BPMN's own bookkeeping out of the author's hands wherever the compiler can carry it, and spends required syntax only where the alternative breaks round-trip fidelity, gives up a cross-reference, or collides with the audience's own variable names.

An error or escalation code is declared once, beside the `var` declarations at the top of the process body, and named wherever it is raised or caught.
The declaration is `verb Id(settings)` like every other element, so no construct is left over.
`message` is the text a thrown error carries at runtime, the one piece of root data usage cannot supply, and a code no identifier can spell lives on the declaration as a `code` setting, so the use site is a bare name in every case and the awkward spelling is written once instead of at each of its uses.

Root elements are derived, not modeled.
`irToXml` walks the whole IR once, collects every distinct error and escalation code in use anywhere in the document, and synthesizes one `bpmn:Error` or `bpmn:Escalation` root per distinct code, wiring every event definition carrying that code to the same root through `errorRef` or `escalationRef`; a declaration adds one root for a code nothing raises.
A definition without a code, a catch-all, gets no ref and contributes no root, because BPMN treats a ref-less catch as any error, so there is nothing for it to point at.
Root ids are sanitized from the code and de-collided against the rest of the document, under the same rule a synthesized id follows (ADR-0010).

The name and the code both reach BPMN, `@name` holding the declared name and `errorCode` or `escalationCode` holding the code, and they are the same text wherever the code is identifier-shaped.
`operaton:errorMessage` lives on the root rather than at the throw site, because two throws sharing a code share one root and a message at the throw site would need a mechanism to reconcile disagreeing copies.
Import reads the pair back off each root, taking the root's `name` where a declaration can be written with it and minting one from the code otherwise (`claimDeclarationName`, `packages/transform/src/synthesize-ids.ts`), so a root nothing raises imports as a declaration nothing uses.
An imported document whose two roots share a code but disagree on the message is refused rather than merged, since collapsing them would change what a throw carries at runtime.

The reference sits on `VarRef` rather than on an alternative of its own, and this was measured against the grammar rather than reasoned about: the parser cannot separate `error(OUT_OF_STOCK)` from `condition(ready)`, since both are one identifier inside the same `SettingsParens`.
So every identifier in every expression builds the same node, and what separates a code from a variable is the scope it resolves in.
`BpmnScriptScopeProvider` gives a bare word the enclosing process's declarations of its own kind in a code position, and `EMPTY_SCOPE` everywhere else.
Holding the scope to one kind is what makes `escalation(X)` naming an error fail rather than reach the XML as a second root, since an error and an escalation are separate event definitions even under one code.
Outside a code position the link fails by design, and `BpmnScriptDocumentValidator` drops that failure before it becomes a diagnostic, so an ordinary expression sees the undeclared-variable warning and nothing else.

Throw and emit decide terminality by keyword, not by position, so `throw` always ends its path and `emit` always continues into whatever follows it.
A single verb whose compiled form depends on being last in its block looks appealing, one fewer keyword, but it does not survive the round trip.
Take an IR shape the importer must be able to reproduce, a branch that fires an escalation and rejoins the main flow, `split -> A -> escalation-intermediate-throw -> join`.
Printed inside its branch block, that statement is the last statement of the block simply because the branch has nothing after it, not because the event ends anything.
A position-decided desugarer reads "last in block", turns the statement back into an escalation end event on the way in, and drops the join edge the original graph had, so the same printed text would mean two different graphs depending on information the text itself does not carry.
`throw` also matches the intuition every reader brings from exception handling in a general-purpose language, and both escalation forms, end event and intermediate throw, stay independently printable.

`emit` is a general continuing verb, not an escalation-specific one, so error, which has no continuing BPMN form, has no `emit`, and later event kinds that fire and continue reuse the same verb instead of growing their own.
Giving every kind its own throw-and-continue verb turns the surface into a vocabulary quiz.

Trigger kinds and binding fields are validated identifiers, not keywords: `on`, `throw`, `emit` and `alongside` are the only words this event layer reserves.
The reason is the audience, not parsing convenience.
`message` and `code` are two of the most ordinary variable names in Java-style code, and a Langium keyword is lexer-global, so there is no way to reserve a word only inside `on`, `throw` and `emit` and leave it free everywhere else.
What a keyword gives away for free is rebuilt explicitly, each part in the mechanism meant for it: a validator checks each word against its small legal set and names the options directly in the diagnostic, a semantic-token provider marks exactly the AST properties that carry meaning, so `on error` highlights `error` while `var error` stays plain, and completion items are offered at the same positions.
This also pre-pays the next event kinds, since `message` and `signal` become validated trigger values at no additional reserved-word cost.

### Consequences

- Good, because a code has a definition to jump to, a name to rename across every site at once, and a completion list wherever one is legal.
- Good, because an unresolved code is an error naming the declaration to add, rather than a warning about an undeclared variable that reads as though the author meant a variable.
- Good, because every user of one code shares exactly one root element, so a code's message text has exactly one place to live, never several that could disagree.
- Good, because a `bpmn:Error` or `bpmn:Escalation` root nothing raises survives the round trip as a declaration, which a design deriving roots from usage alone has nowhere to put.
- Good, because a code no identifier can spell has one home, so a document arriving with `order.failed` round-trips without that text appearing at every site that raises it.
- Good, because terminality is a property of the word printed, readable without looking at what follows in the block.
- Good, because the soft-word design costs zero additional reserved words when the message and signal triggers arrive.
- Bad, because every code needs a declaration line, so an author who writes a single `throw error(...)` in a five-step process pays a header line for one use.
  The cost is accepted rather than argued away: it buys editor behaviour for a code with several sites, and it buys nothing at all for a code with one.
- Bad, because a name and a code can differ, so a reader of `throw error(OrderFailed)` cannot see the text the engine matches on without reading the header.
- Bad, because the grammar cannot carry the distinction the surface makes, so it is spread over a scope provider, a linker that rewords the failure, and a document validator that drops the failures the author never asked to resolve.
  A reader looking for why `condition(ready)` is not a code has three files to find rather than a grammar rule.
- Bad, because a catch-all definition contributes no root element to inspect, so there is no single element a tool can point to for "this code, however it is caught".
- Bad, because the soft-word design moves work from the grammar into four separate mechanisms, validator, semantic tokens, completion and parser-error messages, that all have to agree on the same two small word sets.
- Bad, because a document whose two roots for one code disagree cannot be imported at all, even when the disagreement reads as cosmetic to a human ("Payment declined" versus "Payment was declined").
  The importer has no way to tell a cosmetic disagreement from a meaningful one, so it refuses both alike.

### Confirmation

`packages/transform/test/ir-to-xml.test.ts` asserts the derivation directly: a document using one code from a handler, a throw, and a catch-all handler produces exactly one root element referenced by every coded use and none by the catch-all, with dedicated cases for id sanitization and collision suffixing.
`packages/transform/test/ast-to-ir.test.ts` and `ir-to-dsl.test.ts` pin the branch-tail counterexample as a round-trip case: an intermediate escalation throw as the last statement of a branch block prints as `emit` and re-imports as the same intermediate throw, never an end event.
`packages/language/test/validating.test.ts` pins the soft-word behaviour, `var message: string` and a task named `error` validating cleanly while an unrecognized trigger word produces the options-naming diagnostic, and `scoping.test.ts` pins the scope in both directions, a bare word in a code position resolving to a declaration of its own kind alone and the same word in an `if` condition resolving to nothing.
The golden pair `tests/golden/event-handlers.{bpmnscript,bpmn}` carries a declaration whose code no name can spell, `error GatewayTimeout(code: "gateway.timeout")`, and a declaration nothing raises or catches, `error STOCK_UNAVAILABLE(...)`, and both gates see them, the byte comparison against the frozen `.bpmn` and the IR-equality comparison across `DSL -> IR -> XML -> IR -> DSL` (`tests/event-handlers.round-trip.test.ts`).

## More Information

ADR-0007 keeps vendor- or serialization-only data at the IR-to-XML boundary rather than in the IR; `errorDecls` and `escalationDecls` are the one exception, and they are an exception because they cannot be derived from usage, not because the boundary rule was relaxed.
Langium's scope provider, linker and document validator are the three seams the bare-name reference uses, and the reason the soft-word design rebuilds highlighting and completion as explicit language-server providers rather than through the keyword table.
