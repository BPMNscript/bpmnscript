---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Timer job settings on the element the engine reads

## Context and Problem Statement

`BpmnParse.parseTimer` builds the job a timer creates from two places: `operaton:exclusive` on the `bpmn:timerEventDefinition` element, and the priority stored on the activity that carries the definition.
`DefaultFailedJobParseListener.parseStartEvent`, `parseBoundaryEvent` and `parseIntermediateCatchEvent` read the retry cycle off the same event element when its type is a timer.
`operaton:exclusive` on the event tag is read by `BpmnParse.parseAsynchronousContinuation` alone, which configures the async continuation job, and with no async flag there is no such job.
The tool wrote `exclusive: false` on the event tag and never on the definition, so every timer job it deployed locked exclusively whatever the script said.
On import the definition's attribute was dropped under a warning claiming the tool keeps that setting.
A host-less `on timer(...)` handler wrote `jobPriority`, `retryCycle` and `exclusive` on the event sub-process it lowers to.
Nothing that creates a timer job looks there, since the timer activity is the start event nested inside it.
Which element should each timer job setting be written on, and how does the surface keep spelling the setting once?

## Decision Drivers

- A setting the script writes must reach the job it names.
- The surface keeps one `exclusive` key per statement rather than one per job the element may create.
- A document the tool wrote must import back to the same script, and a foreign document must import without losing what the engine reads.

## Considered Options

- Write each setting on the element the engine reads it from, and lift a synthesized start's settings back into the handler head on print
- Warn on a host-less timer handler's job settings and point the author at an explicit `start` inside the body
- Give the surface a second key for the timer job's lock, beside the one for the continuation job

## Decision Outcome

Chosen option: write each setting on the element the engine reads it from, because it makes the documented spelling run as written with no new key and no warning.

A node carrying a timer writes its `exclusive` on the `bpmn:timerEventDefinition` as well as on the event tag: the definition's copy locks the timer job, the tag's copy the continuation job an async flag creates.
The moddle descriptor declares the attribute on the definition, so it parses as a typed boolean and the default `true` is omitted on write.
On import the definition's value is taken and the tag's stands in where the definition carries none, so a document the tool wrote before this decision imports unchanged.
Where both are written and differ, the import keeps the definition's and warns once, naming which job each governs, since the surface has one key for both.

A host-less `on timer(...)` lowers `jobPriority`, `retryCycle` and `exclusive` onto the trigger start event it synthesizes, and `asyncBefore` and `asyncAfter` onto the event sub-process, whose continuation job they create.
The printer lifts the three back into the `on timer` head as long as the start prints no statement of its own.
When it does print, they stay on the `start` line, so an authored start inside the body keeps its settings where it wrote them.
On import, a timer-started event sub-process's own `exclusive`, `jobPriority` or `retryCycle` is dropped with a warning, since that copy reaches only its continuation job and the head's spelling is the start's.
Every other host-less handler keeps writing its settings on the event sub-process, as before.

### Consequences

- Good, because `exclusive: false` on a timer start, a hosted timer, an `await timer` and a host-less timer handler now configures the job the timer creates.
- Good, because a host-less `on timer` with `jobPriority` or `retryCycle` deploys a job that carries them.
- Bad, because a timer carrier with an async flag writes `operaton:exclusive` twice, and a document that sets the two apart imports with one of them changed and a warning.

### Confirmation

`packages/transform/test/operaton-moddle.test.ts` pins the typed attribute on the definition and its omission at the default.
`packages/transform/test/ir-to-xml.test.ts` pins the definition and the tag both carrying the lock on a boundary timer and an await, and neither when none is written.
`packages/transform/test/xml-to-ir.test.ts` pins the definition's value on a boundary and an event sub-process start, the tag's as the fallback, the one warning when the two differ, and the warning under which a timer-started event sub-process's own timer job key is dropped.
`packages/transform/test/ast-to-ir.test.ts` and `packages/transform/test/ir-to-dsl.test.ts` pin the three settings on the synthesized start, the async flags on the sub-process, the lifted head, and the authored start keeping its own line.
The frozen pair `tests/golden/engine-attributes.{bpmnscript,bpmn}` carries the lock on the hosted timer's definition.

## More Information

Amends ADR-0022, whose rule that a flow node's settings are written on that node now excepts the timer job's lock, which is written on the definition too.
Amends ADR-0023, whose rule that a host-less handler's attributes go on the sub-process now excepts a timer handler's three timer job settings.
Operaton behaviour was read from `BpmnParse.parseTimer`, `BpmnParse.parseAsynchronousContinuation`, `BpmnParse.createActivityOnScope` and `DefaultFailedJobParseListener.parseStartEvent`.

Related decisions: ADR-0017 (the timer clause), ADR-0019 (the hosted form), ADR-0040 (engine settings on synthesized gateways).
