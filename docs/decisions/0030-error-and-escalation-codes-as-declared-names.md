---
status: accepted
date: 2026-09-07
decision-makers: Marlon Kranz
---

# Error and escalation codes as declared, referenced names

## Context and Problem Statement

BPMN keeps a code in two places.
A `bpmn:Error` or `bpmn:Escalation` root element sits under `bpmn:Definitions` and carries the code, and every event definition that raises or catches that code references the root by id.
ADR-0016 settled that split by deriving the root from usage, so an author writes the code at the use site and the compiler builds the root behind it.

That is enough for a code that is only thrown and caught.
It does not give the code an identity the editor can address.
A site that raises a code and a site that catches it are two string literals that happen to match, so there is nothing to jump to, nothing to rename, and a typo in one of them is a second code rather than a mistake.
ADR-0001 makes editor support the core value of a textual DSL, and a quoted code is the one payload shape none of that support reaches.

What gives an error or escalation code an identity the language server can resolve, without reopening the paren shape ADR-0029 settled?

## Decision Drivers

- Jump-to-definition, find-references, rename and completion are the contribution a textual DSL makes over a graphical editor (ADR-0001).
  A payload the language server cannot resolve is where that contribution stops.
- A mistyped code has to be a diagnostic at the site that wrote it, rather than a second code the export writes a root for.
- Every element is spelled `verb Id(settings)` after ADR-0029, and the error declaration is the last construct with a shape of its own.
- The round trip is byte-exact against frozen artifacts, so import has to reproduce the codes a document arrives with, including a code no identifier can spell and a root nothing raises.
- Whatever resolves a code has to leave every other identifier alone.
  A bare word in `condition(ready)` or in `if (amount > 100)` is a variable, and the undeclared-variable warning is the diagnostic its author needs.

## Considered Options

For a code's identity:

- A declaration in the process header that every use site references
- No declaration, with the validator checking each use site against the set of codes it collects from the document
- A quoted code at each use site, which is what ADR-0016 settled

For where the reference is carried:

- A cross-reference alternative of its own in the shared paren rule
- The reference on `VarRef`, the rule every identifier in an expression already builds, separated by scope

For raising an error:

- `throw error(...)` as the only spelling
- A second spelling on the end statement, `end Finished error(...)`

## Decision Outcome

Chosen: a declaration in the process header, referenced by a bare name at every use site, with the reference carried on `VarRef` and the two readings of a bare word separated by scope.

An error or escalation code is declared once, beside the `var` declarations at the top of the process body, and named wherever it is raised or caught.

```bpmnscript
process order-processing {
  error PAYMENT_DECLINED(message: "The payment was declined")
  error OrderFailed(code: "order.failed")
  escalation MANUAL_REVIEW

  user Pay
  throw error(PAYMENT_DECLINED)

  on Pay: escalation(MANUAL_REVIEW) { user Review }
}
```

The declaration is `verb Id(settings)` like every other element, so ADR-0029's shape covers the surface with no construct left over.
`message` is the text a thrown error carries at runtime, the one piece of root data usage cannot supply and the reason ADR-0016 gave the declaration a form at all.
A code no identifier can spell lives on the declaration as a `code` setting, so the use site is a bare name in every case and the awkward spelling is written once instead of at each of its uses.

The name and the code are both carried into BPMN, `@name` holding the declared name and `errorCode` or `escalationCode` holding the code, and they are the same text wherever the code is identifier-shaped.
Import reads the pair back off each root: `readCodeDecls` synthesizes one declaration per `bpmn:Error` and `bpmn:Escalation`, taking the root's `name` where a declaration can be written with it and minting one from the code otherwise (`claimDeclarationName`, `packages/transform/src/synthesize-ids.ts`).
A root nothing raises therefore imports as a declaration nothing uses, so `unreferencedRoot` covers `bpmn:Message` and `bpmn:Signal`, plus an error or escalation root carrying no code at all, which nothing can key it by.

The reference sits on `VarRef` rather than on an alternative of its own, and this was measured against the grammar rather than reasoned about.
The parser cannot separate `error(OUT_OF_STOCK)` from `condition(ready)`, since both are one identifier inside the same `SettingsParens`, and adding a cross-reference arm to `ParenItem` made Chevrotain report `AMBIGUOUS_ALTERNATIVES` and parse the condition as a reference to a declaration.
So every identifier in every expression builds the same node, and what separates a code from a variable is the scope it resolves in.
`BpmnScriptScopeProvider` gives a bare word the enclosing process's declarations of its own kind in a code position, and `EMPTY_SCOPE` everywhere else.
Holding the scope to one kind is what makes `escalation(X)` naming an error fail rather than reach the XML as a second root, since an error and an escalation are separate event definitions even under one code.
Outside a code position the link fails by design, and `BpmnScriptDocumentValidator` drops that failure before it becomes a diagnostic, so an ordinary expression sees the undeclared-variable warning and nothing else.

Rejected: collecting the codes a document uses and checking each site against that set in the validator.
It reports the same typo, and it is the smaller implementation, but a diagnostic is all it produces.
The four editor features above read the reference graph, so a design without a reference gives up exactly what motivates the change.

Rejected: `end Finished error(...)` as a second way to raise an error.
`throw` is the statement that raises one, which ADR-0024 settled, and it already lowers to a `bpmn:endEvent` carrying an `errorEventDefinition`.
An `end` spelling adds a reading without adding a meaning, and leaves one IR shape with two printed forms for the printer to choose between, which is the argument ADR-0024 rejected `end E message("Name")` on.

### Consequences

- Good, because a code has a definition to jump to, a name to rename across every site at once, and a completion list wherever one is legal.
- Good, because an unresolved code is an error naming the declaration to add, rather than a warning about an undeclared variable that reads as though the author meant a variable.
- Good, because a `bpmn:Error` or `bpmn:Escalation` root nothing raises survives the round trip as a declaration, which a design deriving roots from usage alone has nowhere to put.
- Good, because a code no identifier can spell has one home, so a document arriving with `order.failed` round-trips without that text appearing at every site that raises it.
- Bad, because every code needs a declaration line.
  That is the ceremony ADR-0016 declined on purpose, and an author who writes a single `throw error(...)` in a five-step process pays a header line for one use.
  The cost is accepted rather than argued away: it buys editor behaviour for a code with several sites, and it buys nothing at all for a code with one.
- Bad, because a name and a code can differ, so a reader of `throw error(OrderFailed)` cannot see the text the engine matches on without reading the header.
- Bad, because the grammar cannot carry the distinction the surface makes, so it is spread over a scope provider, a linker that rewords the failure, and a document validator that drops the failures the author never asked to resolve.
  A reader looking for why `condition(ready)` is not a code has three files to find rather than a grammar rule.

### Confirmation

The golden pair `tests/golden/event-handlers.bpmnscript` and `tests/golden/event-handlers.bpmn` carries the two shapes this decision adds rather than respells: a declaration whose code no name can spell, `error GatewayTimeout(code: "gateway.timeout")`, and a declaration nothing raises or catches, `error STOCK_UNAVAILABLE(...)`.
Both gates see them, the byte comparison against the frozen `.bpmn` and the IR-equality comparison across `DSL -> IR -> XML -> IR -> DSL`, so a name that fails to reach the root or a root that fails to import as a declaration fails the suite (`tests/event-handlers.round-trip.test.ts`).

`packages/language/test/scoping.test.ts` pins the scope in both directions: a bare word in a code position resolves to a declaration of its own kind and to no declaration of the other kind or of another process, while the same word in an `if` condition resolves to nothing and keeps its undeclared-variable warning.

## Pros and Cons of the Options

### A collected code set checked in the validator

Every use site stays a bare word, and the validator gathers the codes the document declares and reports a site naming none of them.

- Good, because it needs no scope provider, no linker wording and no filtering of link failures: one validator rule replaces three mechanisms.
- Good, because a bare word stays a bare word to every other part of the toolchain, so nothing else has to know a code position exists.
- Bad, because it produces a diagnostic and nothing else.
  The editor features that motivate the change read the reference graph, and a validator rule builds none.

### A cross-reference alternative in the shared paren rule

`ParenItem` would gain an arm matching a reference directly, so a code would be a distinct node from an expression and the scope would not have to separate them.

- Good, because the distinction would live in the grammar, where a reader looking for it would find it in one place.
- Bad, because it does not parse.
  `error(OUT_OF_STOCK)` and `condition(ready)` are the same tokens in the same position, and the arm made Chevrotain report `AMBIGUOUS_ALTERNATIVES` and resolve the ambiguity by parsing the condition as a reference.

### `end Finished error(...)`

An error would also be raisable by naming it on an end statement, next to the `terminate` and `cancel` that an `end` already carries.

- Good, because `end` carries a label and `throw` does not, so a labeled error end would keep its caption.
- Bad, because one IR shape would carry two printed forms and the printer would have to choose one, which is what ADR-0024 rejected `end E message("Name")` on.

## More Information

Amends ADR-0016, whose derived-root design this decision keeps and whose rejection of explicit declarations it reverses on an argument that decision did not weigh.
Amends ADR-0014, whose warned-construct list no longer covers a coded error or escalation root, and ADR-0017, whose contrast between message and signal roots and the error root's declaration now runs along a different line.

Related decisions: ADR-0029 (the bracket shape the declaration takes, and the ordering rule that makes a lone identifier in parens a payload).
ADR-0024 (the verbs at the process boundary, and the reason an error is raised with `throw` alone).
ADR-0010 (the sanitize-then-suffix collision rule, which the name minted for an unspellable code follows the same way a synthesized id does).
ADR-0002 (Langium, whose scope provider, linker and document validator are the three seams this decision uses, none of which the grammar could replace).

Amended by ADR-0038, which adds a third site naming a declared code beside a throw and a catch: an external task's `error <Code> when <condition>` mapping, whose code resolves in the same scope and derives the same root.
