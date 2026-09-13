---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# Mail and shell tasks as a `type` binding

## Context and Problem Statement

Operaton runs two built-in behaviours off a service-task-like element that carry no code of their own: a mail task and a shell task.
Each is dispatched by `operaton:type` instead of a class, an expression, or a delegate.
`BpmnParse.parseServiceTaskLike` reads that attribute before any code attribute: `mail` builds `parseEmailServiceTask`, `shell` builds `parseShellServiceTask`, `external` builds `parseExternalServiceTask`, and any other value fails the deployment.
This surface refused every other `operaton:type` on import, with no way to write either behaviour.
Each behaviour also runs its own field checks before the engine deploys it.
A mail task needs `to` and one of `text`/`html`; a shell task needs only `command`.
Both refuse a field name their behaviour class does not declare, and a shell task alone also requires a fixed-value shape and three flags that must read `true` or `false`.
Where does this surface let an author write a mail or a shell task, and which of these engine checks should the validator mirror before a document ever reaches the engine?

## Decision Drivers

- ADR-0021's precedent: an external task folded into `service` as a fourth binding rather than a fifth statement keyword, because the IR already treats every execution form as one tagged union.
- ADR-0013's minimal keyword surface: a dedicated keyword per behaviour costs an English word an author permanently loses, for a distinction the engine already reads off one attribute.
- ADR-0032's rule that a field's legal placement follows the engine's own parser, not its schema, and both new behaviours reach the identical `instantiateDelegate` call a class binding already reaches.
- ADR-0014's honest import contract: a shape the engine refuses to deploy should be refused on import too, rather than carried into a process that cannot start.

## Considered Options

- A fifth binding key, `type`, carrying the engine's own discriminator value
- Two dedicated keywords, `mail` and `shell`
- Dedicated keys, `to:` for a mail task and `command:` for a shell task, with no `type` key at all

## Decision Outcome

Chosen option: a fifth binding key, `type`.

`type: "mail"` or `type: "shell"` sits beside `class`, `expression`, `delegate`, and `topic` in a `service`, `send`, or `decide` task's parens.
It is one more member of `SERVICE_TASK_BINDING_KEYS` and of the exactly-one-binding check the other four already share.
The IR gains one variant on `ServiceTaskBinding`, `{ kind: 'builtin'; type: BuiltinTaskType; fields?: FieldInjection[] }`.
It is tagged by the engine's own `type` value rather than by two separate IR kinds, so every exhaustive switch grows one case instead of two.

It is legal on `service`, `send`, and `decide`, the three tags a code binding already reaches, since a `decide` task with no `decision` key falls back to the same `parseServiceTaskLike` path a service task takes.
It is not legal on `throw` or `emit`.
The same engine method also builds a thrown message's implementation when bound with a topic.
A thrown message opens no member block here, so the fields a mail or shell task's required-field check demands could never be written on one.
`THROW_BINDING_KEYS` excludes `type` for that reason.

`field` lines ride a `type:` binding exactly as they ride `class:` or `delegate:`.
`parseEmailServiceTask` and `parseShellServiceTask` both build their behaviour through `instantiateDelegate`, the identical call a `class` binding's `ClassDelegateActivityBehavior` reaches, so `applyFieldDeclaration` runs the same check regardless of which behaviour declared the names.
`FIELD_BINDING_KEYS` grows from `class`/`delegate` to `class`/`delegate`/`type`, one list every reader already reads.

The validator mirrors the three checks the engine's parse runs before it builds a mail or shell behaviour.
It asks only once `type` is the binding actually written; beside another binding, that conflict is what needs fixing first.
`BUILTIN_REQUIRED_FIELDS` names each required group, keyed by type; `BUILTIN_FIELD_NAMES` names every field the behaviour class declares, in its own declaration order, and refuses any other with the same fact `applyFieldDeclaration` would throw on deployment.
On a shell task alone, the validator also mirrors the value shapes `validateFieldDeclarationsForShell` casts before it looks at any of them.
Every field must be a quoted literal rather than a `"${...}"` expression, and the three flag fields must read `true` or `false`.
All three tables live once in `vocabulary.ts`, read by both the validator and the importer, so a shape refused on one side and accepted on the other cannot happen by construction.

`resultVariable` beside `type:` is accepted and ignored, the same as beside `topic:` today, since `parseResultVariable` is read inside `parseServiceTaskLike` but neither the mail nor the shell branch consults it.
Shell output has one spelling here, `field outputVariable = "..."`, the same field `ShellActivityBehavior.execute` writes the process's stdout to.
Mapping a second name onto it would spell one runtime fact two ways for no reader's benefit.

`validateFieldDeclarationsForShell` checks a shell flag case-insensitively, so `wait: "True"` deploys clean.
`ShellActivityBehavior.readFields` later compares it with `"true".equals(...)`, case-sensitively, and reads it as `false`.
The validator refuses that spelling in a script; the importer carries it as written and warns of the false read.

Import reads `mail` and `shell` back off `operaton:type` on the same three tags.
It refuses the same shapes the engine refuses: a missing required-field group, an undeclared field name, and, on a shell task, an expression-valued field or a flag outside `true`/`false`.
A `type` outside `external`, `mail`, and `shell` keeps refusing exactly as before, the same `addError` branch `parseServiceTaskLike` itself takes.
A `type` on a thrown message refuses too, for the same reason.
Whatever a `type` binding shadows, a code attribute Operaton would never read past it, is dropped with the same shadowing warning an `external` binding's shadowed attributes already draw.

### Consequences

- Good, because a document a real deployment produced, carrying a mail or shell task, now imports and recompiles rather than refusing, the same gap ADR-0021 already closed for an external topic.
- Good, because no keyword is reserved: `mail` and `shell` stay ordinary identifiers, free for a variable or a step name.
- Good, because the required-field, field-name, and shell-value-shape facts each live once, read by the validator and the importer alike, so the two cannot drift apart.
- Bad, because the binding surface now spans five keys instead of four, and the exactly-one-binding message has to name a fifth.
- Bad, because the shell flag's case-sensitivity gap, a written `"True"` deploying and reading as `false`, is a fact this surface documents rather than one it closes.

### Confirmation

The `mail-and-shell` golden pair under `tests/golden` carries a mail `service` task and a shell `send` task, and its suite asserts both round-trip byte for byte.
The validator table in `packages/language/test/validating.test.ts` pins the required-field, undeclared-field, and shell-value-shape refusals, and the fifth row of the exactly-one-binding table.
The transform suites pin the import back, the shadowing warning, and the printed source.
The end-to-end suite deploys a mail task and asserts the engine refuses one with no body, citing the same message `validateFieldDeclarationsForEmail` throws.

## Pros and Cons of the Options

### A fifth binding key, `type`

- Good, because it matches ADR-0021's own precedent: one more member of a binding list the IR, the validator, and the printer already treat as one tagged union.
- Good, because `field` rides this binding for free, the same machinery `class` and `delegate` already extend.
- Bad, because the binding's own value, `"mail"` or `"shell"`, names the engine's attribute rather than a word this surface invented.

### Two dedicated keywords, `mail` and `shell`

- Good, because a reader would see both behaviours named directly, rather than as a value under a shared `type` key.
- Bad, because it reserves two English words no earlier binding needed, for a distinction the IR already collapses into one binding kind.

### Dedicated keys, `to:` and `command:`, with no `type` key

- Good, because a mail task's recipient would sit directly in the parens rather than inside a member block.
- Bad, because a mail task takes up to eight fields and a shell task twelve, more than a settings key per field can hold without duplicating the member-block machinery `field` already provides.

## More Information

The IR variant is declared beside `ServiceTaskBinding` in `packages/transform/src/ir/types.ts`.
`TYPE_BINDING_KEY`, `TYPE_BINDING_VALUES`, `BUILTIN_FIELD_NAMES`, `BUILTIN_REQUIRED_FIELDS`, and `SHELL_FLAG_FIELDS` are declared beside `SERVICE_TASK_BINDING_KEYS` in `packages/language/src/vocabulary.ts`.

Amends ADR-0021, whose "exactly one of the four" binding count grows to five.
Amends ADR-0032, whose field-binding rule grows from `class`/`delegate` to `class`/`delegate`/`type`.
Amends ADR-0014, which narrows the `type` refusal to a value outside `external`, `mail`, and `shell`, and whose warned list gains a mail or shell task's shadowed attributes.

Related decisions: ADR-0006 (the engine-agnostic IR whose tagged union this decision extends).
ADR-0013 (the minimal keyword surface a fifth key, rather than two more keywords, follows).
ADR-0014 (the honest import contract behind every refusal above).
ADR-0021 (folding an external topic into `service` as a fourth binding, the precedent this decision repeats for a fifth).
ADR-0026 (task kinds on the authoring surface, the three tags `parseServiceTaskLike` dispatches from).
ADR-0032 (field injection, whose placement rule this decision extends to a third binding).
