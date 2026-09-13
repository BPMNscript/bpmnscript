---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# External task extras ride the topic binding

## Context and Problem Statement

A `service`, `send`, or `decide` step bound with `topic:` hands its work to an external worker, and the engine reads three more things beside the topic there and nowhere else.
`BpmnParse.parseExternalServiceTask` reads `operaton:taskPriority` through `parsePriority`, an `operaton:properties` block through `BpmnParseUtil.parseOperatonExtensionProperties`, and each `operaton:errorEventDefinition` under `extensionElements` through `parseOperatonErrorEventDefinitions`.
The priority orders the task in a worker's fetch, the properties travel with it, and a definition raises a BPMN error when its expression holds on a reported failure.
This surface spelled none of the three, so an import dropped the priority and the properties with a warning and reported the definition as an extension element the moddle descriptor did not declare.
Where do the three go on a step, and what does the import do with each shape the engine accepts?

## Decision Drivers

- No new reserved word, the driver ADR-0029 lists and ADR-0032 and ADR-0037 held to.
- The one bracket shape of ADR-0029: scalar settings in the parens, structured members in the braces.
- A mapping names an error code, and ADR-0030 made every code a declared name the editor resolves.
- The import contract of ADR-0014: refuse what the engine refuses, warn on what changes, drop nothing in silence.
- Typed IR fields as ADR-0022 requires, so an extra under a binding the engine never reads it for is a type error.
- The spellings were fixed before the design: `taskPriority:`, `property key = "value"`, and `error <Code> when <condition>`.

## Considered Options

- `when` as a soft word told apart by lookahead, or as a keyword
- A mapping as a member line, as a settings key, or as a nested block
- The extras on the external binding, or on the service task node beside it
- The extras on a thrown message binding a topic too, or on the three task kinds alone

## Decision Outcome

Chosen: both words soft, a mapping as a member line, the extras on the external binding, and the three task kinds alone.

`taskPriority` is a settings key on `service`, `send`, and `decide`, legal beside `topic` alone.
Its value is an integer, a quoted integer, a bare variable name, or a `"${...}"` expression, since `parsePriority` parses a constant as an integer and fails the deployment on anything else.
`jobPriority` goes through the same method and the same check.

`property key = "value"` is the `IoParameter` direction ADR-0037 added for a form field, admitted in a task's braces the same way.
It reaches the wire as `operaton:property name=`, where a form field's is keyed by `id`, because `BpmnParseUtil.parseOperatonExtensionProperties` and `DefaultFormHandler.parseProperties` read the same tag by different attributes.

`error <Code> when <condition>` is a fourth member shape of the shared block.
It parses as `ID ID ID Expr`, and the only other member opening with two identifiers is a parameter, `ID ID '='`, so the parser tells them apart at the third token.
Neither `error` nor `when` is reserved.
`error` is the trigger word every code site writes, and a mistyped `when` is a validator message saying what to write.
The code slot is a cross-reference in the scope a `throw error(X)` resolves in, so an undeclared code draws the linker's message and jump-to-definition works.
The condition is evaluated on the task's execution by `ExternalTaskEntity.evaluateThrowBpmnError`, where `VariableScopeElResolver` resolves `externalTask` to the task entity beside every process variable.
The validator admits that name inside a mapping's condition and nowhere else, so in an `if` it stays an undeclared variable.
The engine runs the mappings on a failure and again on a completion, in document order, and the first true one raises its code with the reported message.

In the IR the three sit on the external variant of `ServiceTaskBinding`, as `taskPriority`, `properties`, and `errorMappings`.
The type then cannot carry them under a class, expression, delegate, or decision binding, which keeps every direction's guard a type check (ADR-0022).
A mapping counts as a use of its code, so a `bpmn:error` root is derived for it as for a throw (ADR-0016).
A task prints its injected fields, then its properties, then its mappings, then its parameters and listeners.

The import boundary follows ADR-0014.
Two shapes refuse as `UnsupportedErrorMappingError`.
A definition with `errorRef` and no `expression`, which `parseOperatonErrorEventDefinitions` fails the deployment on.
One whose `errorRef` names no root, or a root without a code, the refusal a throw's dangling reference already draws.
The moddle deletes an unresolved reference, so a definition written without `errorRef`, which the engine skips, arrives identical to a dangling one, and both refuse.
Warned, one per item: the three on a class, expression, delegate, or decision binding, naming `parseExternalServiceTask` as the only reader, since the step runs without them either way.
`errorCodeVariable` and `errorMessageVariable` on a mapping are stored and never read on the throw side, since `BpmnExceptionHandler.propagateBpmnError` writes them off the catching definition, so they warn as on a thrown error.
A property missing its name or its value is skipped with a warning.
A repeated name is kept once with its last value, as the engine's `HashMap` keeps it, at its first position, and the warning names the rewrite.
A second `operaton:properties` block is reported, since the engine reads one.

A message throw bound with a topic reaches `parseExternalServiceTask` too.
The surface carries the three on the task kinds alone, so on a thrown message the generic sweeps report each as not imported.
`send` and `decide` take them because `parseSendTask` and `parseBusinessRuleTask` without a `decisionRef` dispatch through the same `parseServiceTaskLike`.

### Consequences

- Good, because no word is reserved: `when` and `property` stay ordinary identifiers, and `error` already headed every code site.
- Good, because a mapping's code has a declaration to jump to and a rename that reaches it.
- Good, because a worker's priority, its properties, and its failure mappings round-trip without a warning.
- Bad, because the shared block holds a fourth member shape, told from a parameter at the third token rather than by a head word.
- Bad, because `externalTask` is a name the validator admits in one position and warns on in every other.
- Bad, because a definition missing its `errorRef`, which the engine would skip, refuses on import, since the moddle leaves nothing to tell it from a dangling one.

### Confirmation

The `external-task` golden pair under `tests/golden` compiles to the shape `parseExternalServiceTask` reads, imports back with no warning, and prints to source that re-desugars to the same IR.
Its suite asserts the complete binding of all three tasks at every hop and the frozen `extensionElements` text.
The validator table in `packages/language/test/validating.test.ts` pins each diagnostic, and the import tables in `packages/transform/test/xml-to-ir.test.ts` pin each refusal and warning.
`tests/e2e/forms-and-external-tasks.test.ts` fetches the charge from a real engine and fails it with a matching and a non-matching message.

## Pros and Cons of the Options

### `when` as a soft word

- Good, because ADR-0017's rule holds: a word is reserved only where lookahead cannot do the job, and here it can.
- Bad, because the validator checks the word, and the editor highlights it through semantic tokens alone.

### `when` as a keyword

- Good, because a mapping is told from a parameter by its second token.
- Bad, because it reserves a word for a distinction the third token already makes.

### A mapping as a member line

- Good, because several mappings repeat the way parameters do.
- Bad, because the block's member shapes are four.

### A mapping as a settings key or a nested block

- Bad, because a settings key holds one value where a task carries several mappings, and a nested block is the cost ADR-0032 refused for `fields { }`.

### The extras on the binding, or on the node beside it

- Good for the binding, because the type forbids them wherever the engine never reads them.
- Bad for the node, because a rule then has to say they are empty unless the binding is external.

### The extras on a thrown message too

- Good, because the engine reads them there.
- Bad, because the engine reads the priority and the mappings off the message definition and the properties off the event element, a split shape of its own for a fourth site.

## More Information

Amends ADR-0014 (the refusal list gains `UnsupportedErrorMappingError`, the warned list the extras on a non-external binding) and ADR-0021 (the `topic` binding carries the three extras).
Amends ADR-0030 (a mapping is a third site naming a declared code) and ADR-0032 (the `property` direction rides a `topic` binding too).
Amends ADR-0037 (`property` is shared with an external task, keyed differently on the wire) and ADR-0029 (an error mapping joins the members the braces hold).

Related decisions: ADR-0007 (the moddle fork, which gains `taskPriority` on `ServiceTaskLike` and a concrete `ErrorEventDefinition` type beside the trait carrying the catch-side variables).
ADR-0016 (derived root elements, which a mapping's code now feeds).
