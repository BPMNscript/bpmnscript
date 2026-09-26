---
status: accepted
date: 2026-09-10
decision-makers: Marlon Kranz
---

# Forms and field injection

## Context and Problem Statement

Three Operaton surfaces attach to an element this language already models rather than to a new BPMN construct.
A service task, a send task, a business rule task, and both listener kinds can carry Operaton fields: name and value pairs injected into the Java bean the class or delegate binding instantiates.
A user task can carry a form reference by id and version, an alternative to the fixed form key the surface already writes.
A form field carries four things beyond its id, type, label and default: a validation list, an enum's values, a date pattern, and a property list, read by `DefaultFormHandler.parseValidation`, `DefaultFormHandler.parseProperties`, and `FormTypes.parseFormPropertyType`.
None of the three needs a new flow node or a new statement keyword; each needs a place inside a member block or a settings list an element already has.

What is open for a field is where that place is, since Operaton's moddle schema admits one almost anywhere `extensionElements` can appear while its parser reads one off only a narrow set of bindings.
`IoParameter` already spells `input greeting = "hello"` and `output result = "${x}"` inside the brace block a service-task-like statement opens, and a field is the same shape: a name, an `=`, and a value that is either a literal or a raw expression.
A field also has two XML slots for the same runtime value, `stringValue` as an attribute and `<operaton:expression>` as a child, and the surface has to pick one spelling rather than grow a second vocabulary for a distinction no author can act on.

What is open for a form reference is which element gets it and what has to go with it: the schema allows one on a user task and on a start event, while the parser refuses to deploy a form reference with no binding or one beside a form key.
What is open for a form field is where its four parts go, and what the import does with a shape the engine deploys but this surface cannot check.

## Decision Drivers

- Every reserved keyword is a name an author permanently loses.
- Operaton's own parser decides what is legal, not what its schema merely allows to be written.
- The one bracket shape of ADR-0011: scalar settings in the parens, structured members in the braces.
- An illegal combination should be unrepresentable in the IR's type rather than merely checked for, continuing the convention ADR-0021 set for engine attributes generally.
- A closed set of constraint names the validator can check.
- The import contract commits this tool to refusing what the engine refuses and warning on what changes, never dropping in silence something that would change what the engine does (ADR-0012).

## Considered Options

- Reuse `IoParameter` as a third direction, `field`: it already parses any identifier in the direction position, so a direction costs no grammar rule and no reserved word and inherits the duplicate-key check, the highlighting, and the completion, at the price of one rule carrying two kinds of member.
- A dedicated `FieldInjection` rule: the rule name alone would say what a member is, but `field` becomes a word an author permanently loses, and the placement and value rules are the same whichever rule carries them.
- A nested `fields { }` sub-block: it collects an element's fields under one head, but nests a second member-block shape inside the first, where `input` and `output` already repeat with none.
- Two DSL spellings, one for `stringValue` and one for `<operaton:expression>`: the slot the exporter writes would be visible in the source, but the two slots behave identically until the value reads `${...}`, which the single spelling already tells apart, and choosing between them requires knowing Operaton's XML.
- `formRef` on a user task only: it sits beside `formKey`, so both ways of naming a form are read in one place, at the price of a start event's form reference this surface cannot express.
- `formRef` on a user task and a start event, matching Operaton's schema: it accepts every placement the schema allows, but a start event carries no `formKey` here either, so it closes one half of that asymmetry and leaves the other standing.
- Constraints as settings in the field's parens, values and properties as members of its braces: it is the one bracket shape, so a reader derives a field's spelling from any other element, at the price of two member shapes under one block.
- Constraints as member lines beside the values: a field would have one member list and no parens, but `required` on its own line reads as a part the field is built from rather than a rule it is checked under.
- A nested `validation { }` block inside the field: it mirrors the XML, and nests a second block shape inside a field, the cost a `fields { }` block was already refused for.
- `enum` and `property` as soft words rather than keywords: `var enum: string`, a step named `property`, and every existing file stay legal, and an enum value cannot be named by a reserved word, the limit a field id and a parameter name already have.
- Constraints in the IR as an ordered list rather than flat named fields: the engine's validation order survives the round trip with one map per direction, where flat fields lose the XML order and need a plumbing site per name per direction.
- A fixed `validator:` key rather than an open key set: an unknown name is a diagnostic here instead of a failed deployment there, and a validator registered under its own engine name is written `validator: "<class>"` instead.

## Decision Outcome

The three rest on the same kind of evidence: what Operaton's own parser reads off an element, not what its schema merely permits to be written there.
Field injection reuses `IoParameter` as a direction, `formRef` lands on a user task alone and requires a binding, and a form field takes constraints in its parens and members in its braces with every word soft, an ordered constraint list, and a closed key set.

`field greeting = "hello"` sits beside `input` and `output` inside the same member block a service task, a send task, and a business rule task open, and inside a listener's own block too.
`IoParameter` already parses `direction=ID name=ID '=' value=IoValue` for any identifier in the direction position, so the grammar accepts `field` with no new rule at all, and it is the validator, not the parser, that checks which directions a given owner allows.
A fourth direction, `property`, joins the three the same way.
The one grammar edit this decision needs is the brace block a listener gains.

That brace block is forced, not chosen, once a field needs to repeat.
Spelling it as a setting instead, `service S(field: "greeting=hello")`, hits two limits the settings surface already has: `checkDuplicateKeys` rejects a repeated setting key, and a setting's value is typed as an expression, which admits no map literal that could hold several named fields at once.
A member block, where `params+=IoParameter*` already repeats freely, is the only surface with room for more than one.
Operaton hands a field list to a class-bound and a delegate-expression-bound listener of either kind exactly as it does to a service task, so `on <event>(...) { }` takes the same rule the task's own block uses.
A field is none of the three things a listener's block still refuses to nest: it is not a form, not an input or output parameter, and not a nested listener (ADR-0020).

A field's value has one DSL spelling regardless of which of Operaton's two XML slots it lowers to: a quoted string lowers to the `stringValue` attribute and a `"${...}"` raw expression to an `<operaton:expression>` child, the same literal-versus-expression split `renderIoValue` already draws for an io parameter's value.
The moddle already normalizes an `expression` attribute into a child element on its own, so a normalizing round trip is not new here.
The one shape this rule cannot close is a `stringValue` that reads `${...}`: writing it back would turn a literal Operaton injects verbatim into an expression Operaton evaluates instead, so that shape keeps a drop warning naming the reason rather than being carried.

Where a field is legal follows the engine, not the schema.
`BpmnParse.parseServiceTaskLike` hands `parseFieldDeclarations` to `ClassDelegateActivityBehavior`, to `ServiceTaskDelegateExpressionActivityBehavior`, and to the mail and shell behaviours it instantiates itself; nothing else takes one.
`ServiceTaskExpressionActivityBehavior` is built from an expression and a result variable with no field list, and `parseExternalServiceTask` is never handed one either.
`parseExecutionListener` and `parseTaskListener` repeat the identical split for both listener kinds, neither of which binds a built-in type.

`formRef` lands on a user task only, matching where `formKey` already sits.
Operaton's schema also allows a `formRef` on a start event, but this language does not carry `formKey` on a start event either, so giving `formRef` a start-event home would fix half of an existing asymmetry and leave the other half standing, which is a larger, separate change.
A `formRef` requires a binding because `BpmnParse.parseFormDefinition` calls `addError` when `formKey` and `formRef` are both present on one task, and again when `formRef` carries a binding that is absent or outside `latest`, `deployment`, and `version`.
The IR carries a form reference as a key and a binding with the binding required, which is what makes the invalid state unrepresentable rather than merely refused later, and both hops report it: when Operaton itself refuses to deploy a shape, the importer refuses it too rather than carrying something that would never run.

A form field reads `id: type "label" = default (settings) { members }`, which is the bracket shape of ADR-0011 applied at no grammar cost.
The grammar's type rule is `VarType | ID`, so `enum` costs no keyword, and the validator holds the word to the five types the engine registers.
Constraints are written in the order the engine validates them, and the IR keeps that order as a list keyed by a closed name union rather than as flat named fields.
That key set stays closed even though `customFormTypes` and `customFormFieldValidators` can register more: engine configuration is something this surface cannot see, so a name registered there is indistinguishable from a typo, and `validator` with a class name reaches a custom validator anyway.

### Consequences

- Good, because no word is reserved by any of the three.
  `field`, `property`, `enum` and the form-field setting keys stay ordinary identifiers, and `formRef` is one more setting key rather than a keyword.
- Good, because a field and a property reuse the io-parameter machinery already built for `input` and `output`: the duplicate-key check, the highlighting, and the completion all extend to them for free.
- Good, because the illegal states are unrepresentable rather than merely checked.
  A field has no binding-key slot to sit in on an expression, a topic, or a decision binding, a form reference with no binding cannot be constructed in the IR at all, and an illegal constraint name is a type error.
- Good, because a document Operaton itself refuses to deploy is refused on import, and a field the engine would deploy and then fail on every submission or render is a diagnostic naming the fix.
  A Modeler-drawn form carrying any of the four parts imports, prints, and recompiles to the same IR.
- Bad, because a listener's brace block now holds two kinds of member under the same grammar rule, an io parameter and a field, so a reader has to check the direction word rather than the rule name to know which one they are looking at.
  A form field's braces hold two member shapes told apart at the third token for the same reason.
- Bad, because the field-placement rule is a fact about Operaton's parser, not its schema, so it has to be documented rather than discovered from the moddle alone.
- Bad, because a constraint the engine deploys on the wrong type is carried on import with a warning, so the printed script does not compile until the author moves it.

### Confirmation

The `forms` golden pair under `tests/golden` compiles to the exact `operaton:formField` shape, imports back with no warning, and prints to source that re-desugars to the same IR, and its suite asserts the complete `FormField[]` of both forms at every hop.
The validator table in `packages/language/test/validating.test.ts` pins each diagnostic, and the import tables in `packages/transform/test/xml-to-ir.test.ts` pin each refusal, drop, carry, and rewrite.

## More Information

Related decisions: ADR-0008 (the Operaton moddle extension fork, which carries the `Properties`, `Property`, `Validation`, and `Constraint` types).
ADR-0012 (the honest import contract behind every refusal and warning here).
ADR-0017 (the binding keys a field rides, and the `property` direction shared with an external task).
ADR-0020 (the listener surface whose brace block holds a field beside its bindings).
ADR-0021 (engine attributes as named IR fields, the typing rule a field, a form reference, and the constraint name union all follow).
