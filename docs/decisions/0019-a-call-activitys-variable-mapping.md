---
status: accepted
date: 2026-09-11
decision-makers: Marlon Kranz
---

# A call activity's variable mapping

## Context and Problem Statement

Operaton lets a call activity name a Java class or a bean expression that computes its in and out variable mapping in code, written as `operaton:variableMappingClass` or `operaton:variableMappingDelegateExpression` on the element.
Both mechanisms run, and the delegate runs last on each side.
`BpmnParse.parseCallActivity` reads `operaton:in` and `operaton:out` unconditionally, with no guard on either attribute.
`CallableElementActivityBehavior.execute` builds the variable map from the in mappings and hands the already populated map to the delegate, which mutates it, and `CallableElementActivityBehavior.passOutputVariables` applies the out mappings first and runs the delegate after.
A delegate therefore overrides a declared mapping rather than replacing it, so a document carrying one loses nothing on the way in.

What is open is everything else: what the two attributes spell on the authoring surface, whether that spelling sits in the call's parens or its braces, what shape the IR gives the pair, and what happens on a document that sets both at once.

## Decision Drivers

- The honest import contract (ADR-0012) reserves a refusal for loss that changes execution, and the engine runs a declared mapping and a delegate alike.
- An injected field is legal on a `class` or a `delegate` binding, a rule about binding words that stays keyed on a word alone only while no other binding spells itself with them (ADR-0018).
- The one bracket shape (ADR-0011) puts a setting that describes the element in the parens and a list with members of its own in the braces.
- An illegal combination should be unrepresentable in the IR's type rather than merely checked for, the convention ADR-0021 set for engine attributes.
- Operaton resolves a document setting both attributes with an if/else-if in `BpmnParse.parseCallActivity`: the class wins and the delegate expression is dropped with no diagnostic.

## Considered Options

- `mapper` for the class and `mapperDelegate` for the expression: the field rule stays a rule about the words `class` and `delegate`, true at every site that states it, at the price of two words describing a Java binding without using either word the surface uses for one everywhere else.
- `class` and `delegate`, the words a service task's own bindings use: they match the Java shape and the attribute names the engine reads, but a call activity's variable mapping receives no field list, so the field rule would have to name an element as well as a word at each of the seven sites that state it, `FIELD_HOSTS_MESSAGE` included.
- A setting in the call's parens: a variable mapping describes the call itself and has no members, which is the line ADR-0011 draws, and the offer order, the printed order, and the completion snippet all come from one row; a long call then carries the binding and the mappings in two different brackets.
- A member of the call's brace block, beside its `in` and `out` mappings: it would sit beside the mappings the delegate computes, but the braces hold lists whose members repeat, where a call names one mapping delegate or none, and it would need a grammar rule where a setting key needs none.
- A `CallVariableMapper` of its own, tagged `class` or `delegateExpression`: the two attributes Operaton reads are exactly the two tags, so a third spelling cannot be constructed and no slot is unreachable, at the price of a second class-or-expression union in the IR.
- The `CodeBinding` a service task and both listener kinds already carry: a call activity's delegate would be written the way a service task's is, but its `expression` member has no attribute to lower to and its `fields` slot would be present and always empty.
- An author-time error, and on import the class with a warning naming the dropped delegate: the author is told at the one moment a choice is still open and the import keeps what the engine keeps, at the price of two hops answering the same question differently.
- Mirroring the engine on both hops, taking the class in silence: one rule covers both directions, and it reproduces a silent drop on the hop where a diagnostic costs nothing.

## Decision Outcome

Chosen: `mapper` and `mapperDelegate` in the parens, carried by a `CallVariableMapper` of their own, mutually exclusive at author time and resolved to the class with a warning on import.

A variable mapping delegate has the Java shape of a `class` or a `delegate` binding and none of its behaviour, because Operaton hands it no field list: `instantiateDelegateClass` constructs the delegate with a null field-declaration list, and `ClassDelegateUtil.applyFieldDeclaration` returns without setting anything when the list is null.
Spelling it with those two words would make every site that states the field rule false at once and re-key the rule from which word to which word on which element.
A distinct word is the honest one anyway: on a service task `class` names what runs, while here the delegate names what computes the data crossing the process boundary.

A variable mapping is one setting on the call rather than a list with members of its own, so it goes where ADR-0011 puts a setting, and that one row is the whole authoring surface: the grammar already accepts any identifier as a setting key, completion derives its offer from the element's own keys, and the printer prints in the same order.

The IR carries a `CallVariableMapper` tagged `class` or `delegateExpression` rather than reusing `CodeBinding`, on two counts the engine decides.
`CodeBinding`'s `expression` member has no counterpart on a call activity, because Operaton reads exactly two attributes there and declares no `operaton:variableMappingExpression`, so reusing the type would admit a third spelling that a hand-written validator rule then has to refuse.
Its `fields` slot would be present and always empty, since that slot exists for the two behaviours Operaton injects into and a variable mapping is neither.

Two spellings on one call is an author-time error, delegated to `checkAtMostOneBinding` so the sentence is the one every other exclusive pair on the surface prints.
Import cannot refuse the same shape: Operaton deploys and runs the document with the class, so under ADR-0012 there is no execution loss to refuse for, and the import takes the class and reports the dropped delegate as shadowed.
There is no rule between a mapper and the call's `in` and `out` mappings, because the engine runs both.
The round-trip fixture therefore authors a mapper beside an `in` and an `out` mapping rather than alone, and a reader who adds an exclusivity rule turns it red.

Either spelling names an implementation of Operaton's `DelegateVariableMapping`, whose two methods are `mapInputVariables(DelegateExecution, VariableMap)` and `mapOutputVariables(DelegateExecution, VariableScope)`.
Nothing on the authoring or the import hop can check that the named class implements it, since `resolveDelegateClass` and `instantiateDelegateClass` resolve the class when the call executes rather than when the document deploys.

### Consequences

- Good, because a document Operaton deploys and runs imports and re-exports.
- Good, because the field rule stays keyed on a word alone.
  A mapper carries no injected field and takes none, so that rule needs no element-by-element exception and no site that states it has to change.
- Good, because a mapper and the declared `in` and `out` mappings sit in one call with no rule between them, which is what the engine does with them.
- Bad, because the call surface gains two words for a binding shaped in Java exactly like a `class` or a `delegate` binding and deliberately not spelled like one.
  A reader has to be told why rather than read it off the surface.
- Bad, because neither the validator nor the importer can check a mapper.
  The class is resolved when the call executes, so a misspelled name, or one whose class implements nothing, passes both hops and fails in the engine.

### Confirmation

The mapper block in `tests/call-activity.round-trip.test.ts` authors each spelling beside an `in` and an `out` mapping on the same call and asserts the whole IR node, the serialized Operaton attribute, an empty warning list, an identical re-import, the printed setting in its canonical position, and that the printed source revalidates.
The import table in `packages/transform/test/xml-to-ir.test.ts` pins both attributes under both namespace prefixes and the both-set case, asserting the whole mapper object and the whole warning list rather than membership in either.

## More Information

Related decisions: ADR-0008 (the Operaton moddle extension fork, which declares both attributes, without which moddle drops them on write).
ADR-0018 (the field rule this spelling keeps keyed on a word alone).
ADR-0021 (engine attributes as named IR fields, the precedent `CallVariableMapper` extends).
