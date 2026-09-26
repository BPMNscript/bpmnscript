---
status: accepted
date: 2026-08-16
decision-makers: Marlon Kranz
---

# Service task bindings, including external, mail and shell

## Context and Problem Statement

A `service`, `send`, or `decide` step names the work it runs with a binding key in its parens.
Operaton dispatches every form of that work from one place.
`BpmnParse.parseServiceTaskLike` reads `operaton:type` before any code attribute: `external` builds `parseExternalServiceTask`, `mail` builds `parseEmailServiceTask`, `shell` builds `parseShellServiceTask`, and any other value fails the deployment.
With no `operaton:type`, the same method reads a class, an expression, or a delegate expression.
Each form also reads its own extras, and refuses to deploy some of the combinations an author can write beside a binding.
Which keys does this surface offer, what does each compile to, which extras ride which binding, and which combinations are refused?

## Decision Drivers

- ADR-0007 models every service-task execution form as one tagged union, `ServiceTaskBinding`, rather than as separate node kinds, so a surface that splits what the IR unifies is an asymmetry with no consumer that benefits from it.
- ADR-0006 commits the language to the smaller keyword surface: a reserved word is a name an author can never choose for a variable or a step, and both `external` and `mail` are words a real process is likely to want.
- ADR-0012's import contract: refuse what the engine refuses, warn on what changes, drop nothing in silence.
- ADR-0013's rule that a deployment refusal the engine's parser raises is reported in the editor first, with the fix named.
- ADR-0021 requires typed IR fields, so an extra under a binding the engine never reads it for is a type error.
- The one bracket shape of ADR-0011: scalar settings in the parens, structured members in the braces.
- ADR-0018's rule that a field's legal placement follows the engine's own parser rather than its schema.
- A mapping names an error code, and ADR-0023 makes every code a declared name the editor resolves.

## Considered Options

- `topic` as a binding key rather than `external` as its own statement keyword: a keyword would flag at the step that the work runs in a separately deployed worker, but it reserves an English word for a distinction that produces no distinct BPMN element and that Operaton itself spells as `operaton:type="external"` on an ordinary `bpmn:serviceTask`.
- `type` as a binding key rather than `mail` and `shell` as two more keywords: naming each behaviour directly would cost two more reserved words for a distinction the engine reads off one attribute and the IR collapses into one binding kind.
- `type` rather than dedicated `to:` and `command:` keys: a mail task takes up to eight fields and a shell task twelve, more than a settings key per field can hold without duplicating the member-block machinery `field` already provides.
- The external extras on the binding rather than on the service task node beside it: on the binding the type forbids them wherever the engine never reads them, while on the node a rule has to say they are empty unless the binding is external.
- An error mapping as a member line rather than a settings key or a nested block: several mappings repeat the way parameters do, where a settings key holds one value and a `fields { }` nesting is the cost ADR-0018 refused.
- `when` as a soft word rather than a keyword: lookahead settles the shape, so reserving the word buys nothing, and the price is that the validator checks the word and the editor highlights it through semantic tokens alone.
- The extras on the three task kinds alone rather than on a thrown message binding a topic too: the engine does read them there, but off the message definition for the priority and the mappings and off the event element for the properties, a split shape of its own for a fourth site.
- A result variable refused beside a class or delegate binding rather than warned and dropped on import or accepted on both sides: dropping it prints a script that differs from the document, and accepting it keeps producing documents the engine refuses.

## Decision Outcome

A step's settings carry exactly one of five binding keys: `class`, `expression`, `delegate`, `topic`, and `type`.
The validator's zero-binding and more-than-one-binding messages name all five, so every key is discoverable from the error text alone.
There is no `external`, `mail`, or `shell` keyword, and each word parses as an ordinary identifier free for a variable or a step name.
`THROW_BINDING_KEYS` carries the four code and topic keys but not `type`: a thrown message opens no member block here, so the fields a mail or shell task's required-field check demands could never be written on one.

The IR variant for a built-in behaviour is `{ kind: 'builtin'; type: BuiltinTaskType; fields?: FieldInjection[] }`, tagged by the engine's own `type` value rather than by two IR kinds, so every exhaustive switch grows one case instead of two.
A field rides a `type:` binding for the same reason it rides `class:`: `parseEmailServiceTask` and `parseShellServiceTask` both build their behaviour through `instantiateDelegate`, the identical call a `class` binding's `ClassDelegateActivityBehavior` reaches, so `applyFieldDeclaration` runs the same check whichever behaviour declared the names.

The validator mirrors the checks the engine's own parse runs before it builds a mail or shell behaviour: the required field groups, the field names each behaviour class declares, and the value shapes `validateFieldDeclarationsForShell` casts.
The tables behind all of them live once in `packages/language/src/vocabulary.ts`, read by both the validator and the importer, so a shape refused on one side and accepted on the other cannot happen by construction.

Three extras ride the `topic` binding and no other, because `parseExternalServiceTask` alone reads them.
`taskPriority` is a settings key, while a property and an error mapping are member lines of the block the step already opens.
`error <Code> when <condition>` is parsed as `ID ID ID Expr`, told apart from a parameter's `ID ID '='` at the third token, so neither `error` nor `when` is reserved.
The code slot is a cross-reference in the scope a `throw error(X)` resolves in, so an undeclared code draws the linker's message, jump-to-definition works, and a `bpmn:error` root is derived for the use as for a throw.
The condition is evaluated on the task's execution by `ExternalTaskEntity.evaluateThrowBpmnError`, where `VariableScopeElResolver` resolves `externalTask` to the task entity beside every process variable.
In the IR the three sit on the external variant of `ServiceTaskBinding`, so the type cannot carry them under a class, expression, delegate, decision, or built-in binding and every direction's guard stays a type check.
A task prints its injected fields, then its properties, then its mappings, then its parameters and listeners.

`resultVariable` is refused beside `class` or `delegate` because `parseServiceTaskLike` fails the deployment there, with the message `'resultVariableName' not supported for <element> elements using '<attribute>'`.
The validator quotes that refusal under the element name the engine uses and names the fix, and the importer refuses the same document with the same text.
Like the built-in field checks, these checks ask only once exactly one binding is written; a task with two bindings has that conflict to fix first.

### Consequences

- Good, because there is one keyword surface to teach: an author reads that a step can call a class, an expression, a delegate expression, an external worker, or a behaviour the engine builds itself, as five keys of the same statement rather than as five statements that compile to the same element.
- Good, because no word is reserved for any of them: `external`, `mail`, `shell`, `when`, and `property` stay ordinary identifiers, and `error` already headed every code site.
- Good, because boundary-event host enumerations, the reserved-step-name check, and every other place the grammar or validator listed task kinds side by side name `service` once.
- Good, because a document a real deployment produced, carrying an external, mail, or shell task with its priority, its properties, and its failure mappings, imports and recompiles without a warning.
- Good, because a mapping's code has a declaration to jump to and a rename that reaches it, and a script that would fail deployment over its result variable draws an error at the setting.
- Bad, because a reader skimming XML sees `operaton:type="external"` as a distinguishing marker that the source surfaces as a setting in a step's parens, and nothing in `service Ship(topic: "...")` tells a reader who does not know `topic` that this step runs in a separately deployed process.
- Bad, because the shared block holds a fourth member shape, told from a parameter at the third token rather than by a head word.
- Bad, because `externalTask` is a name the validator admits in one position and warns on in every other.
- Bad, because the shell flag's case-sensitivity gap, a written `"True"` deploying and reading as `false`, is a fact this surface documents rather than one it closes.
- Bad, because the engine's refusal text for a result variable is quoted by the validator and by the importer separately, so a change in the engine's wording is two edits.

### Confirmation

The `external-task` golden pair under `tests/golden` compiles to the shape `parseExternalServiceTask` reads, imports back with no warning, and prints to source that re-desugars to the same IR; its suite asserts the complete binding of all three tasks at every hop and the frozen `extensionElements` text.
The `mail-and-shell` golden pair carries a mail `service` task and a shell `send` task and round-trips byte for byte, and the `engine-attributes` pair binds its `AssessBodywork` task with an expression beside its `resultVariable`.
The binding tables in `packages/language/test/validating.test.ts` pin the exactly-one-binding message, the required-field, undeclared-field, and shell-value-shape refusals, each external-extra diagnostic, and `resultVariable` beside each of the five bindings, and the import tables in `packages/transform/test/xml-to-ir.test.ts` pin each refusal and warning.
`tests/e2e/forms-and-external-tasks.test.ts` fetches the charge from a real engine and fails it with a matching and a non-matching message, and the mail end-to-end case asserts the engine refuses a mail task with no body, citing the same message `validateFieldDeclarationsForEmail` throws.

## More Information

The binding union and its variants are declared in `packages/transform/src/ir/types.ts`, the key and field tables in `packages/language/src/vocabulary.ts`, the validator's binding tables in `packages/language/src/bpmn-script-validator.ts`, and the importer's checks in `readServiceTaskBinding` in `packages/transform/src/xml-to-ir.ts`.

Related decisions: ADR-0007 (the IR between the AST and BPMN XML, whose tagged union these keys are the surface of).
ADR-0012 (the honest import contract behind every refusal and warning above).
ADR-0018 (field injection, whose placement rule extends to a third binding, and the `property` direction shared with an external task).
ADR-0008 (the moddle fork, which gains `taskPriority` on `ServiceTaskLike` and a concrete `ErrorEventDefinition` type beside the trait carrying the catch-side variables).
