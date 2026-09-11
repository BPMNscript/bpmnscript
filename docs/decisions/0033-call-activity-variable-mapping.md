---
status: accepted
date: 2026-09-11
decision-makers: Marlon Kranz
---

# Carry a call activity's variable mapping under its own two setting keys

## Context and Problem Statement

Operaton lets a call activity name a Java class or a bean expression that computes its in and out variable mapping in code, written as `operaton:variableMappingClass` or `operaton:variableMappingDelegateExpression` on the element.
Import refused both, and the message it threw said the delegate replaces the `operaton:in`/`operaton:out` mapping and that importing it would pass no variables into or out of the called process.
The engine's own parser and behaviour class say otherwise.
`BpmnParse.parseCallActivity` reads `operaton:in` and `operaton:out` unconditionally, with no guard on either attribute.
`CallableElementActivityBehavior.execute` builds the variable map from the in mappings and hands the already populated map to the delegate, which mutates it.
`CallableElementActivityBehavior.passOutputVariables` applies the out mappings first and runs the delegate after.
Both mechanisms run on each side with the delegate last, so a delegate overrides a declared mapping rather than replacing it, and a document carrying one loses nothing on the way in.

What is open is everything else: what the two attributes spell on the authoring surface, whether that spelling sits in the call's parens or its braces, what shape the IR gives the pair, and what happens on a document that sets both at once.

## Decision Drivers

- The honest import contract (ADR-0014) reserves a refusal for loss that changes execution, and the engine runs a declared mapping and a delegate alike.
- ADR-0032 states where an injected field is legal as a rule about two words, `class` and `delegate`, and that rule stays a one-word rule only while no other binding spells itself with them.
- ADR-0029 puts a setting that describes the element in the parens and a list with members of its own in the braces.
- An illegal combination should be unrepresentable in the IR's type rather than merely checked for, the convention ADR-0022 set for engine attributes.
- Operaton resolves a document setting both attributes with an if/else-if in `BpmnParse.parseCallActivity`: the class wins and the delegate expression is dropped with no diagnostic.

## Considered Options

For the spelling:

- `mapper` for the class and `mapperDelegate` for the expression
- `class` and `delegate`, the words a service task's own bindings use

For the placement:

- A setting in the call's parens
- A member of the call's brace block, beside its `in` and `out` mappings

For the IR shape:

- A `CallVariableMapper` of its own, tagged `class` or `delegateExpression`
- The `CodeBinding` a service task and both listener kinds already carry

For a document setting both attributes:

- An author-time error, and on import the class with a warning naming the dropped delegate
- Mirroring the engine on both hops, taking the class in silence

## Decision Outcome

Chosen: `mapper` and `mapperDelegate` in the parens, carried by a `CallVariableMapper` of their own, mutually exclusive at author time and resolved to the class with a warning on import.

The spelling is the decision the rest hangs off.
A variable mapping delegate has the Java shape of a `class` or a `delegate` binding and none of its behaviour, because Operaton hands it no field list: `instantiateDelegateClass` constructs the delegate with a null field-declaration list, and `ClassDelegateUtil.applyFieldDeclaration` returns without setting anything when the list is null.
ADR-0032's rule that a field rides a `class` or a `delegate` binding and no other is therefore still a rule about two words, and seven sites in the source and the documentation state it that way.
Spelling a variable mapping with those two words would make all seven false at once and re-key the rule from which word to which word on which element.
It would cost a user-facing diagnostic too, since `FIELD_HOSTS_MESSAGE` is derived from the `fields` flag on `ATTRIBUTE_BLOCK_RULES`: flipping a call activity to carry fields would rewrite the sentence every element that hosts none prints.
A distinct word is also the honest one.
On a service task `class` names what runs; here the delegate names what computes the data crossing the process boundary, which is a different job that happens to share a Java shape.

The placement follows from what the thing is.
A variable mapping is one setting on the call rather than a list with members of its own, so it goes where ADR-0029 puts a setting, and `CallActivity.own` gains the two keys after `businessKey`.
That one row is the whole authoring surface: the grammar already accepts any identifier as a setting key, completion derives its offer from `own`, and the printer prints in the same order.

The IR carries a `CallVariableMapper` tagged `class` or `delegateExpression` rather than reusing `CodeBinding`, on two counts the engine decides.
`CodeBinding`'s `expression` member has no counterpart on a call activity, because Operaton reads exactly two attributes there and declares no `operaton:variableMappingExpression`; reusing the type would admit a third spelling that a hand-written validator rule then has to refuse, re-creating by hand the exclusion a tagged union states for free.
And `CodeBinding`'s `fields` slot would be present and always empty, since that slot exists for the two behaviours Operaton injects into and a variable mapping is neither.

Two spellings on one call is an author-time error, delegated to `checkAtMostOneBinding` so the sentence is the one every other exclusive pair on the surface prints.
Import cannot refuse the same shape: Operaton deploys and runs the document with the class, so under ADR-0014 there is no execution loss to refuse for.
The import takes the class and reports the dropped delegate as shadowed, the report an implementation attribute outranked by a higher-ranked one already gets.

There is no rule between a mapper and the call's `in` and `out` mappings, because the engine runs both.
That is the claim the refusal rested on, so the round-trip fixture authors a mapper beside an `in` and an `out` mapping rather than alone, and a reader who adds an exclusivity rule turns it red.

Either spelling names an implementation of Operaton's `DelegateVariableMapping`, whose two methods are `mapInputVariables(DelegateExecution, VariableMap)` and `mapOutputVariables(DelegateExecution, VariableScope)`.
Nothing on the authoring or the import hop can check that the named class implements it, since `resolveDelegateClass` and `instantiateDelegateClass` resolve the class when the call executes rather than when the document deploys, so a wrong parent class is a runtime failure.

`calledElementTenantId` stays refused, by the same function and for a reason that holds: it pins which tenant the engine resolves the called process against, so dropping it changes which process runs.
It is the one attribute on a call activity this surface still refuses.

### Consequences

- Good, because a document Operaton deploys and runs imports and re-exports, instead of being refused on a reading of the engine that the engine's own source contradicts.
- Good, because the field rule stays keyed on a word alone.
  A mapper carries no injected field and takes none, so ADR-0032 needs no element-by-element exception and no site that states it has to change.
- Good, because a mapper and the declared `in` and `out` mappings sit in one call with no rule between them, which is what the engine does with them.
- Bad, because the call surface gains two words for a binding shaped in Java exactly like a `class` or a `delegate` binding and deliberately not spelled like one.
  A reader has to be told why rather than read it off the surface.
- Bad, because neither the validator nor the importer can check a mapper.
  The class is resolved when the call executes, so a misspelled name, or one whose class implements nothing, passes both hops and fails in the engine.

### Confirmation

The mapper block in `tests/call-activity.round-trip.test.ts` authors each spelling beside an `in` and an `out` mapping on the same call and asserts the whole IR node, the serialized Operaton attribute, an empty warning list, an identical re-import, the printed setting in its canonical position, and that the printed source revalidates.
The import table in `packages/transform/test/xml-to-ir.test.ts` pins both attributes under both namespace prefixes and the both-set case, asserting the whole mapper object and the whole warning list rather than membership in either.

## Pros and Cons of the Options

### `mapper` and `mapperDelegate`

- Good, because the field rule stays a rule about the words `class` and `delegate`, true at every site that states it.
- Good, because `ATTRIBUTE_BLOCK_RULES.CallActivity` keeps `fields: false`, so the derived diagnostic naming what may host a field is untouched.
- Bad, because two words on the call surface describe a Java binding without using either of the two words the surface uses for one everywhere else.

### `class` and `delegate`

- Good, because the words match the Java shape and the attribute names the engine reads.
- Bad, because a field rides a `class` or a `delegate` binding and no other, and a call activity's variable mapping receives none, so the rule would have to name an element as well as a word.
- Bad, because seven sites state that rule as it stands, and `FIELD_HOSTS_MESSAGE` derives a user-facing sentence from the flag that would have to move.

### A setting in the call's parens

- Good, because a variable mapping describes the call itself and has no members, which is the line ADR-0029 draws.
- Good, because the offer order, the printed order, and the completion snippet all come from the one `own` row.
- Bad, because a long call then carries the binding and the mappings in two different brackets.

### A member of the call's brace block

- Good, because it would sit beside the `in` and `out` mappings the delegate computes.
- Bad, because the braces hold lists whose members repeat, and a call names one mapping delegate or none.
- Bad, because it would need a grammar rule where a setting key needs none.

### A `CallVariableMapper` of its own

- Good, because the two attributes Operaton reads are exactly the two tags, so a third spelling cannot be constructed.
- Good, because no slot on it is unreachable.
- Bad, because a second class-or-expression union sits beside `CodeBinding` in the IR, and a reader has to know why they are not one type.

### The existing `CodeBinding`

- Good, because a call activity's delegate is written the way a service task's is.
- Bad, because its `expression` member has no attribute to lower to, so the type would admit a shape a validator rule then refuses by hand.
- Bad, because its `fields` slot would be present and always empty on a binding Operaton injects nothing into.

### An author-time error, the class with a warning on import

- Good, because the author is told at the one moment a choice is still open.
- Good, because the import keeps what the engine keeps and names what it drops, which is the two-tier contract.
- Bad, because the two hops answer the same question differently, so the rule has to be read twice.

### Mirroring the engine on both hops

- Good, because one rule covers both directions.
- Bad, because it reproduces a silent drop on the hop where a diagnostic costs nothing, which is what the surface exists to avoid.

## More Information

Amends ADR-0014, whose refused-construct list read "a call activity naming a resolution shape the surface cannot write back"; the bullet now names the four shapes this decision leaves refused.

Related decisions: ADR-0029 (the bracket shape that keeps a variable mapping a setting in the parens).
ADR-0032 (the field rule this spelling keeps keyed on a word alone).
ADR-0022 (engine attributes as named IR fields, the precedent `CallVariableMapper` extends).
ADR-0007 (the Operaton moddle extension fork, which has to declare both attributes or moddle drops them on write).
