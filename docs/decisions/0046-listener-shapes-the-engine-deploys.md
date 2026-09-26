---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Listener shapes the engine deploys

## Context and Problem Statement

Deploying the `listeners` and `input-output` golden artifacts to Operaton failed on three shapes the tool wrote and the surface called legal.
`BpmnParse.parseTaskListeners` accepts the event words `TaskListener.EVENTNAME_CREATE`, `EVENTNAME_ASSIGNMENT`, `EVENTNAME_COMPLETE`, `EVENTNAME_UPDATE`, `EVENTNAME_DELETE` and `EVENTNAME_TIMEOUT`, and the assignment word is `assignment`, where the language spelled `assign` and wrote it through to `event="assign"`.
`BpmnParse.parseTimeoutTaskListener` reads the listener's `id` and adds an error when it is null, since the id is baked into the timer job's handler configuration and keys `TaskDefinition.addTimeoutTaskListener`.
The tool wrote no id, and the importer warned one away.
`BpmnParse.checkActivityInputOutputSupported` adds an error for an `operaton:inputOutput` on a `bpmn:subProcess` whose `triggeredByEvent` is `true`, where a host-less `on` handler's `input` and `output` lines lowered exactly there.
Each shape also blocked the import side: a real file carrying `event="assignment"` was refused, and a deployable file with a timeout listener rebuilt to one the engine refuses.
Which spelling, which id and which member set does the surface commit to, so that what it writes deploys and what deploys imports?

## Decision Drivers

- A program the validator accepts must deploy, and a document that deploys must import and rebuild to one that still deploys.
- One fact about the language lives once: the event words, the parameter hosts and the id scheme are read off one table each.
- No new key on the surface for something the engine derives, and no second spelling to document.

## Considered Options

- Spell the event as the engine does, mint the timeout listener's id on export, and refuse parameters on a host-less handler
- Keep `assign` on the surface and map it to `assignment` on the wire in both directions
- Give the timeout listener an `id` key and keep the parameter grant, moving the mapping onto the trigger start event

## Decision Outcome

Chosen option: spell the event as the engine does, mint the id on export, and refuse the parameters, because each rule then follows from one engine method and adds nothing to the surface.

The task listener event is `assignment`, the word in `TASK_LISTENER_EVENTS`, and completion, the validator's list and the importer's refusal all read that table.
Every `timeout` task listener is written with the id `<task id>_timeout_<n>`, `n` counting the task's timeout listeners from one in document order.
An id the document already holds is stepped past the way the synthesized root element ids are.
The importer consumes a task listener's `id` without a warning: on a timeout listener the export re-mints it, and on any other event `BpmnParse.parseTaskListener` never reads it.
An `on` handler takes no `input` or `output` line in either form.
The hosted form lowers to a boundary event and the host-less form to an event sub-process, and the engine refuses a mapping on either (`BpmnParse.parseBoundaryEvents`, `BpmnParse.checkActivityInputOutputSupported`).
The attribute block rule for a handler therefore grants no parameters, and the validator's existing parameter-host message names the kinds that take one.

### Consequences

- Good, because the two golden artifacts, and every program the validator accepts, deploy.
- Good, because a Modeler-authored file with an assignment listener or an id-carrying timeout listener imports without a refusal or a warning.
- Bad, because a timeout listener's authored id is replaced by the minted one on a round trip, so a document that names its timeout listeners rebuilds under the tool's names.
- Bad, because a value a host-less handler's body needs has to be mapped on a step inside the body rather than on the handler.

### Confirmation

`packages/language/test/validating.test.ts` pins `on assignment` accepted and `on assign` refused with the list, and a parameter on either handler form refused with the parameter-host message.
`packages/transform/test/ir-to-xml.test.ts` pins two timeout listeners on one task written as `_timeout_1` and `_timeout_2`, and the second stepping past a task already holding its id.
`packages/transform/test/xml-to-ir.test.ts` pins `event="assignment"` imported, `event="assign"` refused, and a listener id consumed without a warning.
The frozen pairs `tests/golden/listeners.{bpmnscript,bpmn}` and `tests/golden/input-output.{bpmnscript,bpmn}` carry the three shapes and import without a warning.

## Pros and Cons of the Options

### Spell the event as the engine does, mint the id, refuse the parameters

- Good, because the surface has one spelling per fact and the wire carries it as written.
- Good, because the id needs no key: the engine needs one, the author never reads it, and the task id makes it readable.
- Bad, because `assignment` is the longer word, and the validator's list is what teaches it.

### Keep `assign` and map it to `assignment` on the wire

- Good, because the shorter word stays.
- Bad, because one event word would then have two spellings, one in the language and one in every diagram and engine log, and both would need documenting.
- Bad, because the mapping would be the one place `TASK_LISTENER_EVENTS` is not the whole truth about an event word.

### An `id` key on the timeout listener, and the mapping on the trigger start event

- Good, because an authored id survives a round trip.
- Bad, because `BpmnParse.parseStartEvents` calls `ensureNoIoMappingDefined` on every start event, so the nested start cannot take the mapping either.
- Bad, because the key would be the only listener setting the engine derives rather than reads, and every timeout listener would have to spell it.

## More Information

Amends ADR-0023, whose event list spells `assign` and whose timeout listener carries no id.
Operaton behaviour was read from `BpmnParse.parseTaskListeners`, `BpmnParse.parseTaskListener`, `BpmnParse.parseTimeoutTaskListener`, `BpmnParse.checkActivityInputOutputSupported`, `BpmnParse.ensureNoIoMappingDefined` and `TaskListener`.

Related decisions: ADR-0010 (deterministic structural ids), ADR-0014 (the import contract), ADR-0023 (listeners on the attribute block).
