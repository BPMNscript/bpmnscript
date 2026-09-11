---
status: accepted
date: 2026-09-10
decision-makers: Marlon Kranz
---

# Field Injection as a Third Parameter Direction, Form References on User Tasks Only

## Context and Problem Statement

Two Operaton surfaces this language does not yet reach both attach to an element the DSL already models, rather than to a new BPMN construct.
A service task, a send task, a business rule task, and both listener kinds can carry Operaton fields: name and value pairs injected into the Java bean the class or delegate binding instantiates.
A user task can carry a form reference by id and version, an alternative to the fixed form key the surface already writes.
Neither needs a new flow node or a new statement keyword; each needs a place inside a member block or a settings list an element already has.

The open question for fields is where that place is.
`IoParameter` already spells `input greeting = "hello"` and `output result = "${x}"` inside the brace block a service-task-like statement opens, and a field is the same shape: a name, an `=`, and a value that is either a literal or a raw expression.
Reusing that rule costs nothing if a field behaves like an io parameter everywhere it can legally sit, and Operaton's own parser has to say where that is, because its moddle schema admits a field almost anywhere `extensionElements` can appear while its parser reads one off only a narrow set of bindings.
A field also has two XML slots for the same runtime value, `stringValue` as an attribute and `<operaton:expression>` as a child, and the DSL surface has to pick one spelling rather than grow a second vocabulary for a distinction no author can act on.

The open question for form references is narrower: which element gets `formRef`, and what has to go with it.
Operaton's schema allows it on a user task and on a start event; this language's user task already carries `formKey`, so `formRef` is the natural second setting there.
Its own parser is stricter than its schema again: a form reference with no binding, or a form reference beside a form key, both refuse the deployment rather than merely reading oddly.

## Decision Drivers

- Every reserved keyword is a name an author permanently loses.
  ADR-0023 already rejected a `listener` keyword on that ground, and ADR-0029 lists no new reserved words among its own drivers.
- Operaton's own parser decides what is legal, not what its schema merely allows to be written.
  A placement rule read off the schema alone would carry an attribute the engine silently ignores rather than one it acts on.
- An illegal combination should be unrepresentable in the IR's type rather than merely checked for, continuing the convention ADR-0022 set for engine attributes generally.
- The import contract commits this tool to refusing or warning on what it cannot honestly carry, never dropping something that would change what the engine does in silence (ADR-0014).

## Considered Options

For field injection:

- Reuse `IoParameter` as a third direction, `field`
- A dedicated `FieldInjection` grammar rule, with `field` a hard keyword
- A nested `fields { }` sub-block inside the existing member block
- Two DSL spellings, one for `stringValue` and one for `<operaton:expression>`

For form references:

- `formRef` on a user task only, matching where `formKey` already sits
- `formRef` on a user task and a start event, matching Operaton's schema

## Decision Outcome

Two decisions, chosen together because each rests on the same kind of evidence: what Operaton's own parser reads off an element, not what its schema merely permits to be written there.

Field injection reuses `IoParameter` as a third direction.
`field greeting = "hello"` sits beside `input` and `output` inside the same member block a service task, a send task, and a business rule task already open, and, after this decision, inside a listener's own block too.
`IoParameter` already parses `direction=ID name=ID '=' value=IoValue` for any identifier in the direction position, so the grammar accepts `field` with no new rule at all.
The direction word stays a soft word exactly as `input` and `output` already are, free for a variable or a step name everywhere else in a file, and it is the validator, not the parser, that checks which directions a given owner allows.
Zero grammar rule is spent on the direction itself; the one grammar edit this decision needs is the brace block a listener gains, described below.

Rejected: a dedicated `FieldInjection` rule with `field` a hard keyword.
It would reserve a word for an idea `IoParameter` already has room for, the exact cost ADR-0023 already refused to pay for `listener`, and it would still need the same class-and-delegate placement rule and the same one-spelling value rule regardless of which grammar rule carries it.
Rejected: a nested `fields { }` sub-block inside the existing member block.
It adds a second member-block shape nested inside the first for no gain over letting `field` repeat directly where `input` and `output` already do, and every reader of the outer block would have to look one level deeper for the identical list.

The brace block is forced, not chosen, once a field needs to repeat.
Spelling it as a setting instead, `service S(field: "greeting=hello")`, hits two limits the settings surface already has.
`checkDuplicateKeys` rejects a repeated setting key, so a second field on the same element could not repeat `field:`, and a setting's value is typed as an expression, which admits no map literal that could hold several named fields at once.
A member block, where `params+=IoParameter*` already repeats freely, is the only surface with room for more than one.

The same block carries fields on both listener kinds, amending ADR-0023 rather than contradicting it.
Operaton hands a field list to a class-bound and a delegate-expression-bound execution listener and task listener exactly as it does to a class-bound or delegate-expression-bound service task.
Carrying fields on a task but not on a listener would leave one of the two import sites for a dropped field still reporting a drop for a construct this tool otherwise claims to carry.
`on <event>(...) { }` gains a brace block holding `params+=IoParameter*`, the same rule a service task's own block already uses, which gives a listener a member block it did not have before.
ADR-0023 recorded that absence as deliberate, so it is amended rather than left to read as contradicted: a field is none of the three things that ADR ruled out.
It is not a form, not an input or output parameter, and not a nested listener.

A field's value has one DSL spelling regardless of which of Operaton's two XML slots it lowers to.
A quoted string lowers to the `stringValue` attribute, and a `"${...}"` raw expression lowers to an `<operaton:expression>` child, the same literal-versus-expression split `renderIoValue` already draws when printing an io parameter's own value.
On import, an `<operaton:string>` child, the moddle's third value slot, carries into the same IR text `stringValue` would and exports back as `stringValue`, with a warning naming the rewrite.
The moddle already normalizes an `expression` attribute into a child element on its own, so a normalizing round trip is not new here.
The one shape this rule cannot close is a `stringValue` that reads `${...}`.
Writing it back would turn a literal Operaton injects verbatim into an expression Operaton evaluates instead, so that shape keeps a drop warning naming the reason rather than being carried.

Rejected: two DSL spellings, one mirroring `stringValue` and one mirroring `<operaton:expression>`.
The two spellings would name a distinction in Operaton's XML that carries no distinction in what the engine does with either shape until an author writes `${...}`, at which point the one-spelling rule already draws exactly that line.

Where a field is legal follows the engine, not the schema.
Operaton's `BpmnParse.parseServiceTaskLike` hands `parseFieldDeclarations` to `ClassDelegateActivityBehavior` and to `ServiceTaskDelegateExpressionActivityBehavior`, and to nothing else.
`ServiceTaskExpressionActivityBehavior` is built from an expression and a result variable with no field list, and `parseExternalServiceTask` is never handed one either.
`parseExecutionListener` and `parseTaskListener` repeat the identical split for both listener kinds.
So a field rides a `class:` or a `delegate:` binding and nothing else, on a task and on a listener alike; an `expression:` binding, a `topic:` binding, and a `decision:` binding all take none.
The validator reports a field written elsewhere as an error naming the two bindings that do take one, and an imported field found under any other binding keeps a drop warning rather than being carried into a binding the engine would never read it from.

`formRef` lands on a user task only, matching where `formKey` already sits.
Operaton's schema also allows a `formRef` on a start event, but this language does not carry `formKey` on a start event either.
A start owns only a label and an optional form block with no key of its own.
Giving `formRef` a start-event home while `formKey` still has none there would fix half of an existing asymmetry and leave the other half standing, a larger, separate change to that asymmetry rather than a scoping decision that belongs here.
It is a deliberate scope, not an oversight, and the start-event side is a follow-up.

Rejected: `formRef` on a user task and a start event, matching Operaton's schema.
It would close the gap between what this surface accepts and what Operaton allows, but a start event here carries no `formKey` either, so adding `formRef` alone would fix one half of a pre-existing asymmetry while leaving the other half standing.

A `formRef` requires a binding, because Operaton's own parser requires one.
`BpmnParse.parseFormDefinition` calls `addError` when `formKey` and `formRef` are both present on one task, and calls `addError` again when `formRef` is present with a binding that is absent or outside `latest`, `deployment`, or `version`.
Both shapes make the file undeployable rather than merely unusual.
The IR carries a form reference as a key and a binding with the binding required, which is what makes the invalid state unrepresentable rather than merely refused later.
The validator errors on both shapes the same way, and the importer refuses both on the way in, the same rule ADR-0028 already applies to a cancel end outside a transaction block: when Operaton itself refuses to deploy a shape, the importer refuses it too, rather than warning and carrying something that would never run.

### Consequences

- Good, because no word is reserved for either decision.
  `field` stays available as a variable or a step name, and `formRef` is one more setting key rather than a keyword.
- Good, because a field reuses the io-parameter machinery already built for `input` and `output`: the duplicate-key check, the highlighting, and the completion all extend to it for free, the same way ADR-0023 already got the timer clause and the four bindings for free by reusing them for listeners.
- Good, because both illegal states are unrepresentable rather than merely checked.
  A field has no binding-key slot to sit in on an expression, a topic, or a decision binding, and a form reference with no binding cannot be constructed in the IR at all.
- Good, because a document Operaton itself refuses to deploy is refused on import rather than accepted into a state the compiler could not have produced.
- Bad, because a listener's brace block now holds two different kinds of member under the same grammar rule, an io parameter and a field, so a reader has to check the direction word rather than the rule name to know which one they are looking at.
- Bad, because the placement rule for a field, class and delegate only, and nothing on an expression, a topic, or a decision, is a fact about Operaton's parser rather than something visible in its schema, so it has to be documented rather than discoverable from the moddle alone.

## Pros and Cons of the Options

### Reuse `IoParameter` as a third direction

- Good, because `IoParameter` already parses any identifier in the direction position, so `field` costs no grammar rule and no reserved word.
- Good, because the duplicate-key check, the highlighting, and the completion all extend to the new direction unchanged.
- Bad, because one grammar rule then carries two kinds of member, so a reader tells an injected field from an io parameter by the direction word rather than by the rule.

### A dedicated `FieldInjection` rule

- Good, because the rule name alone says what a member is, with no direction word to read.
- Bad, because `field` becomes a word an author permanently loses, the cost ADR-0023 already refused to pay for `listener`.
- Bad, because the placement rule and the value rule are the same whichever rule carries them, so the reservation buys nothing.

### A nested `fields { }` sub-block

- Good, because it collects an element's fields under one head.
- Bad, because it nests a second member-block shape inside the first, where `input` and `output` already repeat with none.
- Bad, because every reader of the outer block has to look one level deeper for the same list.

### Two DSL spellings for the two XML slots

- Good, because the slot the exporter writes is then visible in the source.
- Bad, because the two slots behave identically until the value reads `${...}`, which the single spelling already tells apart on its own.
- Bad, because choosing between them requires knowing Operaton's XML, which is what the surface exists to avoid.

### `formRef` on a user task only

- Good, because it sits beside `formKey`, so both ways of naming a form are written and read in one place.
- Bad, because Operaton's schema also admits a start event, whose form reference this surface then cannot express.

### `formRef` on a user task and a start event

- Good, because it accepts every placement the schema allows.
- Bad, because a start event carries no `formKey` here either, so it closes one half of that asymmetry and leaves the other standing.

## More Information

Related decisions: ADR-0006 (the IR's vendor-neutral naming, which a field's name and value pair and a form reference's key and binding pair both follow).
ADR-0014 (the honest import contract behind every refusal and warning here).
ADR-0021 (folding a fourth service-task binding into an existing keyword rather than adding one, the same reuse-over-reservation reasoning field injection follows for `IoParameter`).
ADR-0022 (engine attributes as named IR fields, the precedent a field and a form reference both extend).
ADR-0023 (the listener surface this decision amends).
ADR-0028 (the refuse-on-parser-rejection rule this decision reuses for a form reference with no binding).
ADR-0029 (no new reserved words among its own drivers, the same driver behind reusing `IoParameter` here).
