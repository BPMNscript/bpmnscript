---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# A result variable rides an expression binding, never a class or delegate one

## Context and Problem Statement

`resultVariable` names the process variable a service task's return value is stored in.
This surface accepted it on a `service`, `send`, or `decide` task beside any of the five bindings, and the importer carried `operaton:resultVariable` beside any binding into the IR.
Operaton does not.
`BpmnParse.parseServiceTaskLike` reads the attribute once, through `parseResultVariable`, which also accepts the older `resultVariableName` spelling.
The `class` branch and the `delegateExpression` branch each fail the deployment when it is set, with the message `'resultVariableName' not supported for <element> elements using '<attribute>'`, where the element is `serviceTask`, `sendTask`, or `businessRuleTask`.
Only the `expression` branch hands it to `ServiceTaskExpressionActivityBehavior`.
The `type` branches for `mail`, `shell`, and `external` never read it, so beside `topic:` and `type:` it stays accepted and ignored, as ADR-0042 already records.
A `decide` task with a `decision` key takes a separate path, `parseDmnBusinessRuleTask`, which reads the attribute into `DmnBusinessRuleTaskActivityBehavior`, so beside `decision:` it is read.
The golden `engine-attributes` fixture carried the exact shape the engine refuses, a class binding beside a result variable, and every suite was green.
What should the validator and the importer do with a result variable beside a class or delegate binding?

## Decision Drivers

- ADR-0014's contract: a shape the engine refuses to deploy is refused on import, never carried into a process that cannot start.
- The validator's standing rule, applied in ADR-0037 and ADR-0042, that a deployment refusal the engine's parser raises is reported in the editor first, with the fix named.
- One fact, one home: which binding a result variable rides is a fact about `parseServiceTaskLike`, and both sides should read it the same way.

## Considered Options

- Refuse it in the validator and on import
- Warn and drop it on import, and keep accepting it in a script
- Keep accepting it on both sides

## Decision Outcome

Chosen option: refuse it in the validator and on import, because the engine fails the deployment and ADR-0014 refuses what fails deployment.

The validator reports an error on the `resultVariable` key of a `service`, `send`, or `decide` task whose one binding is `class` or `delegate`.
The message quotes the engine's own refusal text under the element name the engine uses, and names the fix: bind with `expression` to store the return value, or drop the setting.
It runs beside the `type` checks, only once exactly one binding is written; a task with two bindings has that conflict to fix first.
Beside `expression:` and `decision:` the setting stays clean, and beside `topic:` and `type:` it stays accepted and ignored.

The importer throws `UnsupportedServiceTaskFormError` for a service, send, or business rule task without a `decisionRef` that carries `operaton:resultVariable`, or the older `operaton:resultVariableName`, beside `operaton:class` or `operaton:delegateExpression`.
The refusal quotes the same engine text.
Beside `operaton:expression` the attribute imports and prints as before.

The `engine-attributes` golden pair rebinds its `AssessBodywork` task with an expression, keeps its `resultVariable`, and is refrozen; its `(node id, attribute, value)` contract is unchanged.

### Consequences

- Good, because a script that would fail deployment draws an error at the setting, with the engine's own reason and the binding that does store a return value.
- Good, because a document the engine refuses no longer imports, prints, and recompiles into a document the engine still refuses.
- Bad, because a script carrying the combination draws an error rather than a dropped setting, though it never deployed either way.
- Bad, because the engine's refusal text is quoted by the validator and by the importer separately, so a change in the engine's wording is two edits.

### Confirmation

The binding table in `packages/language/test/validating.test.ts` pins the refusal on `service`, `send`, and `decide` under both bindings, and the clean row for `expression`.
The refusal table in `packages/transform/test/xml-to-ir.test.ts` pins the import refusal for both attribute spellings.
The `engine-attributes` round-trip suite pins the refrozen artifact byte for byte and imports it without a warning.

## Pros and Cons of the Options

### Refuse it in the validator and on import

- Good, because it is the only option under which every document this surface accepts deploys.
- Bad, because an author who wrote the combination gets an error rather than a quiet fix.

### Warn and drop it on import, and keep accepting it in a script

- Good, because an imported document keeps its binding and loses only the attribute the engine would have refused.
- Bad, because the printed script would then differ from the document in a way the author has to notice in a warning, and the same script written by hand would still fail to deploy.

### Keep accepting it on both sides

- Good, because nothing changes.
- Bad, because the surface would keep producing documents the engine refuses, against ADR-0014, and the golden fixture pinning that shape would keep proving nothing.

## More Information

The validator's refused-binding table sits beside the `type` binding tables in `packages/language/src/bpmn-script-validator.ts`; the importer's check sits in `readServiceTaskBinding` in `packages/transform/src/xml-to-ir.ts`.

Amends ADR-0014, whose `UnsupportedServiceTaskFormError` bullet gains this case.

Related decisions: ADR-0014 (the honest import contract behind the refusal).
ADR-0021 (the binding list this rule reads).
ADR-0042 (the `type` binding, whose parse-mirroring checks this one sits beside).
