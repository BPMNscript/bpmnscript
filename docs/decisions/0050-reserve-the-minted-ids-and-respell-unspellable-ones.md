---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Reserve the minted start and end ids exactly, and respell an id the script cannot spell

## Context and Problem Statement

The compiler mints an implicit start and end for every container it lowers: `StartEvent_<container>` and `EndEvent_<container>`, plus `EndEvent_<boundary>` for a boundary escape, resolved against a process-wide taken set (ADR-0010).
The printer leaves those out again, since the compiler re-derives them, and the validator refuses a statement written under one, since the compiler would mint it a second time.
Both sides read the prefixes `StartEvent_` and `EndEvent_` for that, not the ids the compiler mints.
The Modeler names its default start `StartEvent_1`, and 25 of 44 real exported diagrams sampled from public example repositories carry that id.
Under the prefix rule such a start is either left out of the script with its label and its `initiator`, or printed and refused when the script is read back.
Renaming it is not a fix the user can apply without cost: the engine keys history (`HistoricActivityInstance.getActivityId`), migration plans (`MigrationPlanBuilder.mapActivities`) and a modification (`InstantiationBuilder.startBeforeActivity`) on the activity id.

A second defect sits one step over.
A BPMN id is an `xs:ID`, and the script's name slot is the `ID` terminal: letters, digits and `_`, a `-` between them, and no keyword.
An id such as `Task.1`, `user`, `Review-` or `WFP-6-` (the MIWG reference models) is a legal id the script cannot spell, and the printer wrote it verbatim into source that does not parse, with no warning.
Only error and escalation codes went through a minting step.
A form field id or an `operaton:inputParameter` name outside the terminal is the same defect one level down: `input my.param = ...` does not parse either.

What should the validator reserve, what should the printer elide, and what should happen to an id the script cannot spell?

## Decision Drivers

- The goldens: every start and end the compiler mints is of the exact form `StartEvent_<container>`, `EndEvent_<container>` or `EndEvent_<boundary>`, so a rule that names those forms keeps every golden byte-identical.
- ADR-0014's contract: a document that deploys imports, and every change to what runs is reported.
- An activity id is the key the engine's history and migration match on, so a changed id is a changed process, and the report has to say so.
- One fact, one home: the shape of a name is the `ID` terminal, and the transform spells it once for both directions.

## Considered Options

- Reserve the exact minted ids and respell an unspellable id on print, with one warning per rename
- Keep the prefix rule and rename a Modeler default on import
- Refuse every id the script cannot spell

## Decision Outcome

Chosen option: reserve the exact minted ids and respell an unspellable id on print, because the exact forms are the only ids the compiler mints and the respelling keeps every document importable while reporting the one change it makes.

The validator reserves, for each statement, the exact `StartEvent_<c>` and `EndEvent_<c>` of the container `c` whose body holds it: the process, or the nearest `subprocess` or `attempt` block.
The message says the compiler generates that id for the container's implicit start or end.
The prefix patterns for gateways, flows, throws, catches, boundaries and event sub-processes stay as they were.
`StartEvent_1` is an ordinary name.
A handler body's own implicit start and end, and a boundary escape's end, are minted off an id no author writes, so the validator reserves those three forms by prefix instead: `StartEvent_EventSubProcess_`, `EndEvent_EventSubProcess_` and `EndEvent_Boundary_`.

The printer recognizes a minted start or end by the same exact forms, plus `EndEvent_<boundary>` for a boundary in the same container and the `Throw_` prefix an unnamed throw lowers to.
Only those are left out; a start or end under any other id prints with its label, its documentation and its initiator.

The printer builds one map per print, from the process id and every element id that prints, to the name each is written under.
An id the `ID` terminal accepts maps to itself.
Any other maps to the id with every non-word character replaced by `_`, a leading `_` where the result would open on a digit or read as a keyword, resolved against every id in the document and every name minted before it.
Every site that writes an id reads the map: the process head, every statement head, a `goto`, a boundary's host, and a named throw or catch.
A gateway, a boundary and an event sub-process never write their id and keep it.
Each rename draws one `renamedId` warning naming the printed name and saying that the rebuilt document carries it as the activity id.

A form field id or an `operaton:inputParameter`/`operaton:outputParameter` name outside the terminal refuses the import.
The engine sets the variable under that exact name (`FormFieldHandler.handleSubmit`, `InputParameter.execute`, `OutputParameter.execute`), so a minted name would change which variable is set rather than how it is written.

### Consequences

- Good, because a Modeler default diagram imports, prints and rebuilds with its start's id, label and initiator intact.
- Good, because a MIWG reference model prints as source that parses and validates, with one report per id it could not keep.
- Good, because every golden is byte-identical: the exact forms are the ones the compiler already wrote.
- Bad, because a respelled id is a changed activity id in the rebuilt document, so a process rebuilt from such a script is not the process the history and migration APIs know; the warning says so, and the remedy is a rename in the model.
- Bad, because a statement written under another container's minted id, such as `user EndEvent_S` beside `subprocess S`, is legal and makes the compiler mint `EndEvent_S_2` for `S`, which the printer then writes as an ordinary `end EndEvent_S_2`; the round trip stays stable from the second print on, and nothing runs differently.

### Confirmation

The reserved-name table in `packages/language/test/validating.test.ts` pins the exact rule per container and the freed `StartEvent_1`.
The respelling table in `packages/transform/test/ir-to-dsl.test.ts` prints every id site under a minted name, asserts the whole warning list, and re-parses and validates the source; the Modeler-default row asserts the printed start, end and initiator with no warning.
`packages/transform/test/synthesize-ids.test.ts` pins the exact predicates and the minting scheme.
The refusal matrix in `packages/transform/test/xml-to-ir.test.ts` pins the two import refusals.
The golden pair suites pass unchanged.

## Pros and Cons of the Options

### Reserve the exact minted ids and respell an unspellable id on print

- Good, because it matches what the compiler mints, and no golden changes.
- Good, because every legal document prints as source that compiles.
- Bad, because an author can write a name the compiler would otherwise have minted for a sibling container, and the compiler takes the next free suffix rather than refusing.

### Keep the prefix rule and rename a Modeler default on import

- Good, because the printer and validator stay as they were.
- Bad, because the rename changes the activity id of the one element every Modeler diagram has, and a rule that renames a default is a rule that renames most imports.

### Refuse every id the script cannot spell

- Good, because nothing prints under a name the model does not carry.
- Bad, because the MIWG reference models and any diagram with a dotted or hyphen-terminated id would not import at all, although the engine deploys them.

## More Information

The exact predicates and the minting scheme sit in `packages/transform/src/synthesize-ids.ts`; the name map is built by `printedNames` in `packages/transform/src/ir-to-dsl.ts`; the per-container check is `checkReservedNames` in `packages/language/src/bpmn-script-validator.ts`; the two import refusals go through `refuseUnspellableVariable` in `packages/transform/src/xml-to-ir.ts`.

Amends ADR-0010, whose reserved-pattern list narrows to the prefixes above and the exact minted forms.
Amends ADR-0014, whose label bullet names the exact minted ids rather than a prefix, whose warned list gains the `renamedId` respelling, and whose refused list gains a form field id or an input/output parameter name the script cannot spell.

Related decisions: ADR-0014 (the honest import contract behind the refusals and the warning).
ADR-0036 (where an elided end prints under its id, which this decision leaves as it is).
