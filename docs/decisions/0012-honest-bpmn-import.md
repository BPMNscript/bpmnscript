---
status: accepted
date: 2026-07-04
decision-makers: Marlon Kranz
---

# Honest BPMN import: refusals, warnings, and the parse tiers

## Context and Problem Statement

`xmlToIr`'s docstring stated that silent semantic loss is impossible, while the transform dropped several kinds of content without any diagnostic: event definitions on start and end events, loop characteristics on tasks, whole collaborations, Operaton and camunda extension content, and lanes.
Some of those drops change what the imported process executes; others do not.
The import contract has to make good on its own claim: what should happen when `xmlToIr` meets content the IR cannot carry, and should every such case be treated the same way?

A surface that answers from its own reading of the IR disagrees with `BpmnParse` in both directions, refusing files the engine deploys while carrying files it refuses, and it says nothing about what the engine does with what it drops.
Camunda Modeler's default export is the case that costs most: it writes a `bpmn:collaboration` with one participant for any diagram with a pool or a lane, an `isExecutable="false"` process for every empty pool, and `xmlns:camunda` on every file, which is also the shape of the Operaton invoice example and four MIWG reference files.
Document shapes the engine rejects before `BpmnParse` sees an element pass through instead, since moddle-xml and saxen read them where a validating parse does not.
`bpmn:documentation` has no place at all, which keeps the letter of the contract while working against everything the contract exists for.

## Decision Drivers

- The no-silent-semantic-loss claim must hold for content whose absence changes execution semantics: a dropped timer or a dropped loop is not a cosmetic loss.
- Not every unrepresentable construct is equally severe, and refusing content that causes no semantic loss, an extension attribute or a lane, would make the importer unusable on any file a real modeler exports, the Modeler's default output and the Operaton invoice example included.
- The engine's parser is the one reader whose verdict decides whether a document runs, so it is the one reference for where a tier sits, and a warning that names what the engine does with a dropped setting is the only form under which a reader can tell a cosmetic drop from one that changes a run.
- Whatever channel reports non-fatal drops must be impossible to ignore by accident, since a warning nobody reads is a silent drop.
- Consumers, the CLI and the VS Code extension, need one classification check for "is this an unsupported-construct refusal?" that does not enumerate every subclass by hand.
- One fact about the engine lives in one place, in the message or the comment beside the check, naming the method that reads it.

## Considered Options

- Two tiers drawn where `BpmnParse` draws them: refuse what the engine fails the deployment on, warn on what it deploys and this surface cannot spell.
- Refuse everything the IR cannot express, with no warning tier: nothing the engine runs is ever dropped and a listener on a gateway could not slip through, but it refuses every file a real modeler exports over content that costs the reader a warning rather than a run.
- Drop what the IR cannot carry in silence and correct the docstring to describe that.
- Draw the tiers from the surface's own reading of the IR and correct the wording of the drops alone.
- Refuse every setting the engine reads that this surface cannot spell.
- Refuse every collaboration and every multi-process document, on the reading that a pool means several linked processes: nothing is dropped, but the refusal blocks most real input on a shape the engine ignores, and its message called a lone pool "multiple linked processes".
- Write the pool back on export rather than warn that the round trip loses it: the frame would survive, but it needs a `bpmn:collaboration`, a participant shape whose bounds enclose every laid-out element, and a plane over the collaboration, none of which `bpmn-auto-layout` produces, for a frame the engine never reads.
- Read the camunda namespace through a second moddle package, or by rewriting the prefix in the document text: a second package would key every consumption table twice, and a prefix rewrite could hit a prefix spelled inside attribute text, where the URI cannot appear.
- Carry documentation as a list of `{ text, textFormat }` members per node, or rework the printer to give a setting a multi-line entry: nothing in the corpus writes two children on one element, so neither buys anything the single escaped string does not.
- Carry documentation on every element the transform touches rather than on every element that already carries a name.
- For BPMN's own resource roles, refuse the spelling, or carry both spellings in the IR and the script: the round trip would be byte-stable on the roles, but the language then has two spellings for one assignment and the IR two fields the engine merges into one.

## Decision Outcome

Chosen option: two tiers, drawn where `BpmnParse` draws them, because it is the only option consistent with the no-silent-semantic-loss claim that accepts exactly what the engine deploys and says what the engine does with what it drops.

The rule has three clauses.
A shape `BpmnParse` fails the deployment on refuses, and the message names the method and quotes its sentence, since there is nothing that runs to write back.
A shape the engine deploys and this surface can spell is carried, with a warning where the spelling changes.
A shape the engine deploys and this surface cannot spell drops with a warning that names the method that reads it and says the document written back runs without it.
The one drop that refuses instead is a thrown message's result variable beside an `expression` binding, where the engine stores a value the throw has no slot for.

A refusal throws a subclass of `UnsupportedConstructError` before any IR is produced, so there is never a partial IR, and a consumer classifies the whole family with a single `instanceof` check while each subclass still carries construct-specific metadata for a tailored message.
A warning is returned in a `warnings: ImportWarning[]` array alongside the IR, so `xmlToIr` returns `{ ir, warnings }` rather than a bare `BpmnProcess`, which makes the channel unignorable at the type level: every call site must destructure or explicitly discard `warnings`, where an optional collector parameter (`xmlToIr(xml, sink?)`) or a second `xmlToIrWithWarnings` function leaves it easy to skip.
What the engine deploys and then fails on at run time is carried as written, with a warning that the printed script draws an error there.

No element leaves the transform unreported: whatever it cannot carry is named by the tag the document spells and by its own id, and attributed to the element it sat on, a construct being reported whole so that a dropped `bpmn:ioSpecification` names itself rather than each data input inside it.
What is dropped without a warning is the diagram interchange data ADR-0009 settles, a BPMN attribute the transform neither reads nor reports, such as a process's `processType` or `isClosed`, and an attribute in a foreign namespace written directly on a mapped BPMN element, which is where an editor parks its own bookkeeping; the same foreign attribute on an extension child the IR reads is reported.
`packages/transform/README.md` names every refusal class and every warning category with the conditions that reach it, and `docs/bpmn-coverage.md` places each BPMN element on one side of the boundary or the other.

Three document-level shapes follow from the same rule rather than from any one element.
`selectProcess` imports the one process marked `isExecutable="true"` and pushes one warning per other process, since `parseProcessDefinitions` does not deploy those either.
A collaboration is diagram data to the engine, since `parseCollaboration` records a participant's `processRef` only so that `parseBPMNShape` can attach the pool's bounds and no method in `BpmnParse` reads a `bpmn:messageFlow`, so a pool warns rather than refuses.
The camunda namespace is read as the operaton one by replacing the URI in the document text before `moddle.fromXML`, with one warning per document: `BpmnParse.OPERATON_BPMN_EXTENSIONS_NS` falls back to the camunda URI only when the operaton lookup finds nothing, and moddle-xml binds a prefix to a package by URI rather than by spelling, so after the swap every `camunda:` element arrives typed `operaton:*` and every `camunda:` attribute reads through the one `operaton:` reader.

BPMN's own resource roles on a user task import onto the Operaton assignment attributes, with one warning per role naming the rewrite, since `BpmnParse.parseTaskDefinition` reads both into the same assignee and candidate lists that `operaton:assignee`, `operaton:candidateUsers`, and `operaton:candidateGroups` fill.
The exported document carries the Operaton attributes alone, and the engine builds the same identity links from them.

A single plaintext `bpmn:documentation` child imports onto one optional `documentation?: string`, carried wherever an IR node already carries a `name`, with its newline escaped so the printer's `Lines = string[]` model is untouched and Langium's default `convertString` is the exact inverse.
The body is carried verbatim, so a modeler's pretty-printed whitespace inside the element comes back as it was written rather than trimmed.
Tying documentation to the name means the positions that report it instead are already the positions a label is reported at: an element with no slot for a name has no slot for documentation either, so there is one rule rather than two.

The contract covers two hops.
`irToDsl` reports in the same shape, returning `{ source, warnings }` for the reason `xmlToIr` returns `{ ir, warnings }`: a channel a caller can skip is a silent drop.
Some of what its warnings name merely drops, such as a gateway label no statement form can hold; some changes what a recompiled document runs, such as a fallback re-derived on an imported fork whose branches all carry conditions and that named none; and some is printed as the model spells it and draws an error when the source is read back, such as an `else` beside a branch that runs whatever the conditions do.
Every one of them is warned rather than refused, because a refusal has no meaning on this hop: the restructurer is total and always produces source.

### Consequences

- Good, because a document the engine deploys imports, among them the Modeler's default collaboration file, the Operaton invoice example, and the MIWG files with one executable process, and one the engine refuses is refused with the engine's own sentence rather than imported into a script that cannot deploy.
- Good, because every caller, the CLI, the VS Code extension, and the round-trip suite, surfaces both the refusal and the warning channel instead of only one or neither, and the shared `UnsupportedConstructError` base keeps classification to one `instanceof` check as new refusal categories are added.
- Good, because every warning on a setting the engine reads says which method reads it, so the reader knows whether the drop changes a run.
- Bad, because the engine's sentences are quoted in the importer and drift with the engine's wording.
- Bad, because a shape the engine deploys and then fails at run time, such as an empty listener `class` on a task, is carried into a script that draws an error at the step, which the reader has to repair by hand.
- Bad, because some warned items do bear on what runs, against the boundary this decision draws, among them a dropped `operaton:field`, which leaves the bound class without a value it was injected with, and `isExecutable="false"`, which imports as an executable process.
  Refusing either would reject files that otherwise import cleanly, and carrying `isExecutable` through would mean an IR field, a serializer path, and a DSL surface for a flag this tool has no use for.
- Bad, because the round trip rewrites a document in places: the pool is gone, so a pooled diagram opens as a plain process, and a `bpmn:potentialOwner` comes back as `operaton:candidateGroups`.
- Bad, because an id the schema admits and the engine deploys, such as one with an umlaut, is refused until renamed, since moddle-xml cannot read it.
- Bad, because a handful of undeclared `operaton:` extension elements cannot be tied by `bpmn-moddle` to a specific owning element, so their warnings are attributed to the process id rather than the precise element.

### Confirmation

The refusal and warning tables in `packages/transform/test/xml-to-ir.test.ts` pin every documented row with the whole warning list or the refusal class and detail, including the document level, the `camunda: prefix alias` describe, the resource-role merge, and the quantity warning.
`tests/review-loop.round-trip.test.ts` and the invoice fixture in `tests/` pin the Modeler-shaped documents end to end, and `tests/e2e/forms-and-external-tasks.test.ts` deploys the re-export of a task assigned in BPMN's own words to a real engine and reads the identity links back.
The frozen `documentation` golden pair and a parameterized sweep per hop name every position that carries documentation and every position that reports it instead, so a position wired to neither branch fails the sweep rather than passing in silence.

## More Information

The refuse and warn boundary and the `ImportWarning` shape (`elementId`, `category`, `message`) live in `packages/transform/src/errors.ts` and `packages/transform/src/xml-to-ir.ts`, where the checks are `refuseDocumentShapes`, `refuseDroppedIds`, `refuseImports`, `selectProcess`, `warnCollaborationDrops`, `checkExclusiveGateways`, `checkStartEventCount`, `checkHandlerFlows`, `attachDefaultFlows`, `refuseIoMapping`, `onlyExtensionElement`, `resolveListenerBinding`, `readThrownMessageBinding`, and the `ENGINE_READS_ELSEWHERE` table behind `warnUnimportedSetting`; the namespace swap sits at the top of `xmlToIr`.
`PrintWarningCategory` and the warnings built beside it in `packages/transform/src/ir-to-dsl.ts` settle which reports the print hop makes and what each one costs.
The consumer-facing summary is the import contract section of `packages/transform/README.md`.
