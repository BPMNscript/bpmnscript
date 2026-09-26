---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Import Modeler-shaped documents as the engine deploys them

## Context and Problem Statement

Camunda Modeler writes a `bpmn:collaboration` with one participant for any diagram that has a pool or a lane, an `isExecutable="false"` process for every empty pool it draws, and `xmlns:camunda` on every export.
The Operaton invoice example and four of the MIWG reference files have exactly this shape, and this tool refused all of them as "multiple linked processes".
Operaton does not read the document that way.
`BpmnParse.parseRootElement` runs `parseProcessDefinitions`, which deploys every process whose `isExecutable` attribute parses as true, and then `parseCollaboration`, which records each participant's `processRef` so that `parseBPMNShape` can attach the pool's bounds to the process.
No method in `BpmnParse` reads a `bpmn:messageFlow`.
A collaboration is diagram data to the engine, and the one question that decides what runs is how many processes deploy.
An absent `isExecutable` deploys nothing: `parseProcessDefinitions` defaults it to `!deployment.isNew()`, which is false for every deployment of a new resource, while this tool imported such a process as executable and its README said the engine reads it as executable too.
The same audit found document shapes the engine refuses before `BpmnParse` sees an element.
`BpmnParse` sets `BPMN20.xsd` as the schema and `Parse.execute` runs a validating SAX parse, so a duplicate `xs:ID` fails.
`Parser.setXxeProcessing` sets `disallow-doctype-decl` unless XXE processing is enabled, so a `<!DOCTYPE>` fails.
This tool saw neither: moddle-xml drops an element whose id repeats or falls outside its ASCII pattern with a warning, which the importer reported as extra engine configuration or as a dangling reference on an innocent flow.
saxen skips a DOCTYPE and keeps an undeclared entity as literal text.
`BpmnParse.parseImports` fails the deployment on every `bpmn:import` but a WSDL one, and `parseSignals` fails it on two signal roots of one name.
`isSequential` and `triggeredByEvent` are typed `xsd:boolean`, so `Parse.execute`'s validating parse admits only `true`, `false`, `1` or `0` and fails the deployment on any other word, where moddle reads `yes` as false.
What should the importer do with a document whose shape the engine reads differently from this tool?

## Decision Drivers

- ADR-0014's contract: what the engine refuses to deploy is refused on import, what it deploys and this surface cannot spell is dropped with a warning, and nothing changes silently.
- The Modeler's default output has to import, since it is most real input.
- One fact about the engine lives in one place, in the message or the comment beside the check, naming the method that reads it.

## Considered Options

- Import the one executable process, warn per pool and message flow, refuse the document shapes the engine refuses
- Keep refusing every collaboration and every multi-process document
- Write the pool back on export

## Decision Outcome

Chosen option: import the one executable process, warn per pool and message flow, refuse the document shapes the engine refuses, because it is the only option under which the importer accepts what the engine deploys and nothing else.

`selectProcess` imports the one process marked `isExecutable="true"` and pushes one warning per other process, naming it and that `parseProcessDefinitions` does not deploy it either.
Two or more executable processes refuse with `UnsupportedCollaborationError`, which names that one shape alone.
Several processes of which none is executable refuse with `UnsupportedDocumentError`, since the engine deploys none of them.
A lone process without the attribute imports with a warning that says the engine skips it in a new deployment and that this tool writes it back as executable.
`warnCollaborationDrops` pushes one warning per participant, saying whether it names the imported process, a skipped one, or none, and one per message flow with its ends; both say the process runs identically and the document written back has no pool.
Lanes keep their existing warnings.
An empty process refuses with `UnsupportedEventFeatureError`, naming that `BpmnParse.parseStartEvents` fails the deployment on a process or subprocess with no start event.

The camunda namespace is read as the operaton one by replacing the URI in the document text before `moddle.fromXML`, with one warning per document.
`BpmnParse.OPERATON_BPMN_EXTENSIONS_NS` falls back to the camunda URI only when the operaton lookup finds nothing, so the engine reads a `camunda:taskListener` exactly as an `operaton:taskListener`.
moddle-xml binds a prefix to a package by URI, not by spelling, so after the swap every `camunda:` element arrives typed `operaton:*` and every `camunda:` attribute reads through the one `operaton:` reader.
A second moddle package would key every consumption table twice, and a prefix rewrite could hit a prefix spelled inside attribute text; the URI cannot appear there.

`refuseDocumentShapes` runs on the raw text before parsing, on a copy with comments and CDATA sections cut out, since a script body may hold `&name;` or `<!DOCTYPE` legitimately.
It refuses a `<!DOCTYPE>`, an entity XML does not predefine, and an `isSequential` or `triggeredByEvent` value outside `true` and `false`, naming `Parse.execute`'s validating parse against `BPMN20.xsd` as the reason.
After parsing, a moddle warning for a duplicate or an illegal id refuses with the id named and the rename as the remedy, before any reference could dangle on it.
A `bpmn:import` refuses naming its type, and two signal roots of one name refuse naming both.
The DOCTYPE, entity, boolean, id, and import refusals are one `UnsupportedDocumentError`, so the CLI exits 1 for them like for every other refusal.

### Consequences

- Good, because the Modeler's default collaboration file, the Operaton invoice example, and the MIWG files with one executable process import.
- Good, because a file the engine refuses at schema validation or at the DOCTYPE no longer imports, prints, and rebuilds into a different document that deploys.
- Good, because a process the engine would not deploy is named in a warning rather than turned into one that runs.
- Bad, because the document written back has no pool, so a file that opened in the Modeler as a pooled diagram opens as a plain process after the round trip.
- Bad, because an id the schema admits and the engine deploys, such as one with an umlaut, is refused until renamed, since moddle-xml cannot read it.

### Confirmation

The table `xmlToIr: the document level` in `packages/transform/test/xml-to-ir.test.ts` pins every import row with its whole warning list and every refusal with its class and detail.
The camunda rows sit in the `camunda: prefix alias` describe of the same file.

## Pros and Cons of the Options

### Import the one executable process, warn per pool and message flow, refuse the document shapes the engine refuses

- Good, because the import accepts exactly what the engine deploys.
- Bad, because the pool is lost on the round trip, and the warning has to say so.

### Keep refusing every collaboration and every multi-process document

- Good, because nothing is dropped.
- Bad, because the refusal blocks most real input on a shape the engine ignores, and its message called a lone pool "multiple linked processes".

### Write the pool back on export

- Good, because the round trip would keep the diagram's frame.
- Bad, because it needs a `bpmn:collaboration`, a participant shape whose bounds enclose every laid-out element, and a plane over the collaboration, none of which `bpmn-auto-layout` produces, for a frame the engine never reads.

## More Information

The document-level checks sit in `refuseDocumentShapes`, `refuseDroppedIds`, `refuseImports`, `selectProcess`, and `warnCollaborationDrops` in `packages/transform/src/xml-to-ir.ts`; the namespace swap sits at the top of `xmlToIr`.

Amends ADR-0014, whose `UnsupportedCollaborationError` bullet narrows to two or more executable processes and whose `isExecutable="false"` bullet gains the absent attribute.

Related decisions: ADR-0003 (diagram interchange is regenerated, which is why the pool has no export side).
ADR-0014 (the honest import contract behind every refusal and warning here).
