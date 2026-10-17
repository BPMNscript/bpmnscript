---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Deterministic ids for synthesized elements, reserved, and authored ids kept as written

## Context and Problem Statement

The `astToIr` desugarer gives an id to every BPMN element the DSL source leaves unnamed: the exclusive gateway pair enclosing an `if`/`else`, the loop-head gateway for `while`/`do...while`, the fork/join pair for `parallel`, the event-based gateway and exclusive merge for a multi-branch `await`, the catch event each `await` waits at, the boundary event a hosted handler attaches with, the event sub-process a host-less handler becomes, an `emit` or `throw` written without a name, and implicit start/end events.
It also gives every sequence flow its id, since the script never writes a flow: `irToDsl` prints none of the flow ids an imported document carries, and the compiler mints them again when the printed source is compiled.
How should these ids be generated, and what does an author's own name have to stay clear of so that the compiler never mints a second element under an id the document already carries?

The spelling of an author's id is the other half of the same question.
A BPMN id is an `xs:ID`, while the script's name slot is the `ID` terminal: letters, digits and `_`, a `-` between them, and no keyword.
An id such as `Task.1`, `user`, `Review-` or `WFP-6-` (the MIWG reference models) is a legal id the `ID` terminal cannot spell.
The Modeler names its default start `StartEvent_1`, and 25 of 44 real exported diagrams sampled from public example repositories carry that id, so whatever the validator reserves for a start decides whether a typical Modeler diagram imports intact.
Renaming such an element is not a fix the user can apply without cost: the engine keys history (`HistoricActivityInstance.getActivityId`), migration plans (`MigrationPlanBuilder.mapActivities`) and a modification (`InstantiationBuilder.startBeforeActivity`) on the activity id.

## Decision Drivers

- Re-compiling the same source must produce the same BPMN XML; non-deterministic ids would make the output non-reproducible and break byte-comparison golden tests.
- The round-trip normalizer (`tests/helpers/normalize-ir.ts`) must be able to recognize and re-key synthesized ids, which is only practical if the id scheme is stable and documented.
- Sequential counters depend on traversal order, making ids sensitive to unrelated source changes.
- Ids derived from structural position are self-documenting and survive refactoring of unrelated parts of the process.
- The import contract ([ADR-0012](0012-honest-bpmn-import.md#decision-outcome)): a document that deploys imports, unless it marks more than one process executable, holds an event without an id that the engine deploys but cannot run, or uses a construct this surface cannot spell, and every change to what runs is reported.
- An activity id is the key the engine's history and migration match on, so a changed id is a changed process, and the script has to be able to write every id it has a name slot for.
- One fact, one home: the shape of a name is the `ID` terminal, and the transform spells it once for both directions.

## Considered Options

- Structural coordinate: an id derived from the element's position in the process body, with the exact minted ids reserved against author names, matching exactly what the compiler mints so every legal document prints as source that recompiles unchanged
- UUIDs, random and non-deterministic
- A sequential counter, deterministic but traversal-order-sensitive
- Reserving a `StartEvent_` and `EndEvent_` prefix rather than the exact minted ids, and renaming a Modeler default start on import: one rule for both directions without a per-container lookup, but renaming the one element every Modeler diagram has changes most imports' activity id, and without the rename that start is either dropped from the script with its label and initiator or printed and refused on read-back
- Refusing every id the script cannot spell: nothing then prints under a name the model does not carry, but the MIWG reference models and any diagram with a dotted or hyphen-terminated id would not import at all, although the engine deploys them
- Respelling an id the `ID` terminal cannot spell on print, with a warning: every document imports, but the rebuilt document carries the respelled id, so the engine's history and migration APIs no longer know the process, and the only remedy is a rename in the model
- A second name form in backticks that spells any id the engine deploys: every id with a name slot survives import and rebuild, at the cost of a second spelling for a name and one more terminal in the grammar

## Decision Outcome

Chosen option: the structural coordinate with exactly reserved names, and a name form in backticks for an authored id the `ID` terminal cannot spell.
Deriving each id from the element's position in the source makes recompilation reproducible, keeps golden tests stable, and lets a reader trace a synthesized id back to the statement that produced it.
Reserving the exact forms the compiler mints, and writing every other id as it stands, keeps every document importable without changing an id the script has a slot for.

The frozen id templates (from `packages/transform/src/synthesize-ids.ts`):

| Template                    | Produced by                    | Example                                               |
| --------------------------- | ------------------------------ | ----------------------------------------------------- |
| `Gateway_<X>_split`         | `makeGatewaySplitId`           | `Gateway_invoice-approval_2_split`                    |
| `Gateway_<X>_join`          | `makeGatewayJoinId`            | `Gateway_invoice-approval_2_join`                     |
| `Gateway_<X>_fork`          | `makeGatewayForkId`            | `Gateway_invoice-approval_4_fork`                     |
| `Gateway_<X>_race`          | `makeGatewayRaceId`            | `Gateway_invoice-approval_5_race`                     |
| `Gateway_<X>_loop`          | `makeGatewayLoopId`            | `Gateway_invoice-approval_3_loop`                     |
| `Flow_<gatewayId>_default`  | `makeDefaultFlowId`            | `Flow_Gateway_invoice-approval_2_split_default`       |
| `Flow_<src>_<tgt>`          | `makeSequenceFlowId`           | `Flow_ReviewInvoice_Gateway_invoice-approval_2_split` |
| `StartEvent_<processId>`    | `makeStartEventId`             | `StartEvent_invoice-approval`                         |
| `EndEvent_<processId>`      | `makeEndEventId`               | `EndEvent_invoice-approval`                           |
| `Throw_<X>`                 | `makeThrowEventId`             | `Throw_invoice-approval_2`                            |
| `EventSubProcess_<X>`       | `makeEventSubProcessId`        | `EventSubProcess_invoice-approval_1`                  |
| `Catch_<X>`                 | `makeIntermediateCatchEventId` | `Catch_order-handling_5_b0`                           |
| `Boundary_<host>_<trigger>` | `makeBoundaryEventId`          | `Boundary_ApprovePayout_timer`                        |

The structural coordinate `<X>` for a compound statement at body index `i` inside a process with id `P` is `P_i`.
For nested compounds the parent coordinate is prepended (`P_i_j`).
Branch segments distinguish sibling blocks within a compound: `_t` for the if-then block, `_e<i>` (0-based) for else-if branches, `_e` for the else block, and `_b<i>` for the branches of a `parallel` and of a multi-branch `await`.
Loop and sub-process bodies carry no segment, since a single block has no sibling to disambiguate against.
A sub-process body's enclosing coordinate is the sub-process's own `<X>`, so gateways inside it stay positional.
The implicit start and end of a container are seeded from that container's id, the process id at the top level and the sub-process name inside a sub-process, and a boundary escape's end is `EndEvent_<boundary>`; all of them resolve against one process-wide taken set so every id is document-unique.
If a base id is already in the taken set, the resolution appends `_2`, `_3`, and so on until a free slot is found.

Gateway ids skip the `taken`/`resolveCollision` guard, because the position-path scheme never generates the same id twice.
What collides with them is an author-chosen statement name matching a synthesized-id pattern.
The `checkReservedNames` validator in `packages/language/src/bpmn-script-validator.ts` rejects such a name at validation time.
It reserves by prefix `Gateway_*_(split|join|fork|loop|race)`, `Throw_*`, `EventSubProcess_*`, `Boundary_*`, `Catch_*`, `BPMNDiagram_*` and `BPMNPlane_*`, the two-segment `Flow_*_*` form (`/^Flow_.+_.+$/`), and the `*_di` suffix diagram-interchange ids carry.
Single-segment names such as `Flow_Control` stay legal, because synthesized flow ids occupy only `SequenceFlow.id` and never node names, so they cannot collide.
For a start and an end it reserves, for each statement, the exact `StartEvent_<c>` and `EndEvent_<c>` of the container `c` whose body holds it: the process, or the nearest `subprocess` or `attempt` block.
The message says the compiler generates that id for the container's implicit start or end.
`StartEvent_1` is an ordinary name.
A handler body's own implicit start and end, and a boundary escape's end, are minted off an id no author writes, so the validator reserves those three forms by prefix instead: `StartEvent_EventSubProcess_`, `EndEvent_EventSubProcess_` and `EndEvent_Boundary_`.

A flow id collides without any reserved name being written, because the flow into a statement is `Flow_<gatewayId>_<statement>` and a split that names a fallback holds `Flow_<gatewayId>_default` back for it: an `if` chain's fallback, an inclusive fork's fallback, and either loop's exit.
An AND fork and a race reserve nothing, having no fallback to reserve for.
A statement named `default` in an earlier branch of such a split spells that string, and the document would ship two sequence flows under one id, which is not valid BPMN.
`reserveDefaultFlowId` (`packages/transform/src/ast-to-ir.ts`) claims the reserved string before any branch is lowered, so the author's flow takes the next free slot instead.

The printer recognizes a minted start or end by the same exact forms, plus `EndEvent_<boundary>` for a boundary in the same container and the `Throw_` prefix an unnamed throw lowers to.
Only those are left out, since the compiler re-derives them; a start or end under any other id prints with its label, its documentation and its initiator.

Every name slot takes the plain `ID` or the `QUOTED_NAME` terminal: any text on one line between backticks, where a backslash takes the next character literally, as in `` user `Task.1` `` or `` goto `end` ``.
Both carry the bare text, so `` `Review` `` and `Review` are one name to the linker, the duplicate check and every reference.
The printer writes an id plainly where the `ID` terminal lexes it as no keyword, and in backticks otherwise (`printName` in `packages/language/src/vocabulary.ts`).
Every site that writes an id goes through it: the process head, every statement head, a `goto`, a boundary's host, and a named throw or catch.
A gateway of any kind, a boundary event, an event sub-process, the catch event of a race branch and a sequence flow have no id slot in the script.
Their authored ids do not survive a rebuild: the compiler synthesizes each one from the templates above, and no warning reports it.
An element with a name slot keeps its id: a task, a sub-process, a start, an end, a single `await`, and a named `throw` or `emit`.

A name in backticks still becomes an id, so the validator holds a process or statement name to ASCII letters, digits, `_`, `-` and `.`, starting with a letter or `_` (`ENGINE_ID_TEXT`).
Operaton validates every file against `BPMN20.xsd`, which types an id as `xs:ID` and refuses a space or a leading digit, and moddle-xml drops an element whose id holds any letter beyond ASCII.
The import refuses a document with an id outside the same set, such as one with a `:`, which moddle-xml reads as a qualified name and the schema refuses.
The reserved forms above stay reserved in backticks too, because what collides is the id the compiler mints, not its spelling.
A code declaration's name is the root's `name` attribute rather than an id, so in backticks it takes any text on one line, and import keeps the root's `name` as written.
A code is referenced inside a trigger's parens, which the grammar parses as an expression, so a name in backticks is read there and refused anywhere else in an expression, since a variable has no backtick form.

An element the document gives no id gets one on import, before anything keys it.
A sequence flow gets `Flow_<source>_<target>`, and any other element `<Type>_<container>`, from the local name of its BPMN type and the id of the process or sub-process holding it, such as `UserTask_invoice`; both resolve against every id in the document the way the compiler's ids do.
An end event also skips `EndEvent_<id>` for every id in the document and so usually imports as `EndEvent_<container>_2`, since the printer would take such an id for the implicit end the compiler gives a container or a boundary escape and leave the event out.
Operaton deploys such a flow as an unnamed transition and such a task, end or catch as an activity nothing can flow into, since a `sourceRef` or `targetRef` needs an id, so the printer leaves the step out of the script with a warning that no route reaches it.
A start event, a timer event, an event-based gateway, and a message or signal boundary event without an id refuse the import instead, since Operaton fails the deployment on each.
An error, escalation, cancel or conditional boundary event without an id refuses too: Operaton deploys it and fails the run when an error is thrown inside its step, an escalation reaches it, its transaction is cancelled, or its step runs.
A minted id would make the rebuilt document deploy and run where the source does not.
A compensation boundary event deploys and runs without an id, so it takes a minted one like a task, and is then refused like every compensation boundary event ([ADR-0012](0012-honest-bpmn-import.md)).

A form field id or an `operaton:inputParameter`/`operaton:outputParameter` name outside the terminal refuses the import.
The engine sets the variable under that exact name (`FormFieldHandler.handleSubmit`, `InputParameter.execute`, `OutputParameter.execute`), so a minted name would change which variable is set rather than how it is written.

### Consequences

- Good, because re-compiling the same source always produces the same BPMN ids, and golden files stay stable across unrelated source changes.
- Good, because the id scheme is self-documenting: reading a gateway id reveals its position in the source.
- Good, because `synthesize-ids.ts` is a pure, dependency-free module with its own test suite.
- Good, because a Modeler default diagram imports, prints and rebuilds with its start's id, label and initiator intact, and a MIWG reference model prints as source that parses, validates and rebuilds with every activity id it carries.
- Neutral, because the structural coordinate is longer than a UUID, making gateway ids verbose in deep nesting, mitigated by the fact that deeply nested processes are rare in the current scope.
- Bad, because renaming a process id or reordering top-level statements changes all synthesized ids in that process, which breaks deployed BPMN definitions.
  That is a concern for production use and acceptable for a DSL-authoring workflow where recompile is expected to replace the definition.
- Neutral, because a name has two spellings, and the printer uses backticks only where the plain one cannot spell the id, so a script written by hand rarely shows them.
- Bad, because an imported gateway, boundary event, event sub-process or race-branch catch comes back under a synthesized id without a warning, and the engine records these in history under their activity id as it does a task.
  A migration plan written against the original document has to map them anew.
- Bad, because a statement written under another container's minted id, such as `user EndEvent_S` beside `subprocess S`, is legal and makes the compiler mint `EndEvent_S_2` for `S`, which the printer then writes as an ordinary `end EndEvent_S_2`; the round trip stays stable from the second print on, and nothing runs differently.

### Confirmation

`packages/transform/test/synthesize-ids.test.ts` verifies every template, the collision-resolution rule, and the exact predicates for a minted start and end.
The reserved-name table in `packages/language/test/validating.test.ts` pins the exact rule per container and the freed `StartEvent_1`.
The backtick test in `packages/transform/test/ir-to-dsl.test.ts` prints every id site in backticks with no warning, re-parses and validates the source, and compiles it back to the same ids, and the synthesized-terminal test in the same file prints a Modeler default's start, end and initiator with no warning.
`tests/backtick-names.round-trip.test.ts` imports a document per id the plain form cannot spell, asserts the exact printed script, and compiles it to a document with the same ids and no model difference.
The refusal matrix in `packages/transform/test/xml-to-ir.test.ts` pins the two import refusals.
The two id-less tables in the same file pin the minted ids and the id-less events that refuse.
The round-trip normalizer (`tests/helpers/normalize-ir.ts`) uses the id patterns to re-key synthesized ids before comparing IR snapshots, and the golden pair suites pass unchanged.

## More Information

The id templates are frozen, because they are consumed by `astToIr`, `irToDsl`, and the round-trip normalizer.
Any change requires updating all three consumers and regenerating the `invoice-approval-generated.bpmn` golden file.
The frozen contract is documented in the header of `packages/transform/src/synthesize-ids.ts`, which also holds the exact predicates and the minting scheme.
The printed spelling is `printName` in `packages/language/src/vocabulary.ts`; the per-container check is `checkReservedNames` and the id check `checkEngineIds` in `packages/language/src/bpmn-script-validator.ts`; the variable refusals go through `refuseUnspellableVariable` in `packages/transform/src/xml-to-ir.ts`.
