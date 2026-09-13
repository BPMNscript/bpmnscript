---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# Form field constraints, values and properties

## Context and Problem Statement

A form field drawn in the Modeler carries four things this surface could not spell: a validation list, an enum's values, a date pattern, and a property list.
`DefaultFormHandler.parseValidation` reads each `operaton:constraint` by `name` and `config` and hands it to `FormValidators.createValidator`; `DefaultFormHandler.parseProperties` reads each `operaton:property` by `id` and `value`.
`FormTypes.parseFormPropertyType` reads `datePattern` on a `date` field and the `operaton:value` children on an `enum` field.
A field here was `id: type "label" = default`, so an imported enum field refused the document and an imported constraint, pattern, or property dropped with a warning.
Where do the four go on a field, and what does the import do with a shape the engine deploys but this surface cannot check?

## Decision Drivers

- No new reserved word, the driver ADR-0029 lists and ADR-0032 held to for `field`.
- The one bracket shape of ADR-0029: scalar settings in the parens, structured members in the braces.
- A closed set of constraint names the validator can check.
- The import contract of ADR-0014: refuse what the engine refuses, warn on what changes, drop nothing in silence.
- Typed IR fields as ADR-0022 requires, so an illegal constraint name is a type error.

## Considered Options

- Constraints as settings in the field's parens, values and properties as members of its braces
- Constraints as member lines in the braces, beside the values
- A nested `validation { }` block inside the field
- `enum` and `property` as soft words, or as keywords
- Constraints in the IR as an ordered list, or as flat named fields
- A fixed `validator:` key, or an open key set

## Decision Outcome

Chosen option: constraints in the parens and members in the braces, both words soft, an ordered constraint list, and a closed key set.
It is the ADR-0029 shape applied to a field at no grammar cost.

A field reads `id: type "label" = default (settings) { members }`.
The type is `string`, `number`, `boolean`, `date`, or `enum`.
The grammar's type rule is `VarType | ID`, so `enum` costs no keyword, and the validator holds the word to the five and names them on a mistyped type.
An `enum` field's variable is a string, since `EnumFormType.convertValue` stores the chosen value's id.

The parens take seven constraint keys and `pattern`.
`required: true` and `readonly: true` take the literal `true` alone.
`RequiredValidator.validate` and `ReadOnlyValidator.validate` never read a configuration, and `false` has no representation in a constraint list, so `required: false` is an error.
`min`, `max`, `minlength`, and `maxlength` take an integer literal or a quoted integer.
A `number` field is an Operaton `long`, and `AbstractNumericValidator.validate` parses the bound with `Long.parseLong`, the submitted value's own parser, so only an integer survives every submission.
The numeric bounds fit a `number` field and the length bounds a `string` field, since `AbstractNumericValidator.validate` and `AbstractTextValueValidator.validate` throw on a submitted value of any other Java type.
`validator` takes what `class:` takes, a class name or a `${...}` expression, which is what `FormValidators.createValidator` reads off `config`.
`pattern` is not a constraint but the `datePattern` that `FormTypes.parseFormPropertyType` reads on a `date` field alone, so it is legal there and an error on any other type.
Constraints are written in the order the engine validates them, and the IR keeps that order as a list keyed by a closed name union.

The braces take an enum's values, one `id "label"` line each, and `property key = "value"` lines.
A value line on a field that is not an `enum` is an error, and so is a repeated value id.
An `enum` with no values is a warning, as an empty branch body is: the engine deploys it and then rejects every submitted value.
A literal default naming no value is an error, since `FormFieldHandler.createFormField` converts the default through the type on every render, so the form never opens.
`property` is the fourth `IoParameter` direction beside `input`, `output`, and `field`, the same move ADR-0032 made.
The direction word is soft, and the duplicate-key check and the completion come for free.
A property's value is a quoted string or a `${...}` expression, the shapes `DefaultFormHandler.parseProperties` reads as text.

The import boundary follows ADR-0014.
Three shapes are refused as `UnsupportedFormFieldConstraintError`.
A constraint name outside the seven, since `FormValidators.createValidator` fails the deployment on any name it has not registered.
A `validator` or a bound with no `config`, since the first fails the deployment and the second every submission.
A name repeated on one field, since the parens hold each key once and dropping one would change what runs.
Dropped with a warning naming the method that never reads it: `datePattern` off a `date` field, `operaton:value` children off an `enum` field, and `config` on `required` or `readonly`.
Three shapes the engine deploys are carried as written, with a warning that the printed script draws an error at the field.
A bound on a type its validator refuses, a bound whose `config` is not an integer, and a literal enum default naming no value.
Rewritten with a warning: a repeated value id, kept at its first position with its last label, as `FormTypes.parseFormPropertyType` keeps it.

A type outside the five stays refused, and a constraint name outside the seven joins it.
`customFormTypes` and `customFormFieldValidators` are engine configuration this surface cannot see, so a name registered there is indistinguishable from a typo.
`validator` with a class name reaches a custom validator anyway.

### Consequences

- Good, because no word is reserved: `enum`, `property`, and the eight setting keys stay ordinary identifiers everywhere else.
- Good, because a field the engine would deploy and then fail on every submission or render is a diagnostic naming the fix.
- Good, because a Modeler-drawn form carrying any of the four imports, prints, and recompiles to the same IR.
- Bad, because a field's braces hold two member shapes under two grammar rules, told apart at the third token rather than by a head word.
- Bad, because a constraint the engine deploys on the wrong type is carried on import with a warning, so the printed script does not compile until the author moves it.

### Confirmation

The `forms` golden pair under `tests/golden` compiles to the exact `operaton:formField` shape, imports back with no warning, and prints to source that re-desugars to the same IR.
Its suite asserts the complete `FormField[]` of both forms at every hop.
The validator table in `packages/language/test/validating.test.ts` pins each diagnostic, and the import tables in `packages/transform/test/xml-to-ir.test.ts` pin each refusal, drop, carry, and rewrite.

## Pros and Cons of the Options

### Constraints in the parens, members in the braces

- Good, because it is the ADR-0029 shape, so a reader derives a field's spelling from any other element.
- Bad, because the braces hold two member shapes under one block.

### Constraints as member lines

- Good, because a field then has one member list and no parens.
- Bad, because `required` on its own line reads as a part the field is built from rather than a rule it is checked under.

### A nested `validation { }` block

- Good, because it mirrors the XML.
- Bad, because it nests a second block shape inside a field, the cost ADR-0032 refused to pay for a `fields { }` block.

### `enum` and `property` as soft words rather than keywords

- Good, because `var enum: string`, a step named `property`, and every existing file stay legal.
- Bad, because an enum value cannot be named by a reserved word, the limit a field id and a parameter name already have.

### Constraints as an ordered list rather than flat named fields

- Good, because the engine's validation order survives the round trip with one map per direction.
- Bad for flat fields, because the XML order is lost and every name needs a plumbing site per direction.

### A fixed `validator:` key rather than an open key set

- Good, because an unknown name is a diagnostic here instead of a failed deployment there.
- Bad, because a validator registered under its own engine name is written `validator: "<class>"` instead.
- Bad for the open set, because every unregistered name fails the deployment, so the openness buys nothing but a late error.

## More Information

Amends ADR-0014 (the refusal list gains `UnsupportedFormFieldConstraintError`, the warned list the form field drops, carries, and rewrite), ADR-0029 (a form field takes the parens-and-braces shape), and ADR-0032 (three parameter directions become four).

Related decisions: ADR-0007 (the moddle fork, which gains the `Properties`, `Property`, `Validation`, and `Constraint` types).
ADR-0022 (engine attributes as named IR fields, the typing rule the constraint name union follows).

Amended by ADR-0038, under which a `property` line is shared with an external task.
There it reaches the wire as `operaton:property name=`, on a form field as `operaton:property id=`, since the engine reads the two by different attributes.
