---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Listeners reuse `on` inside the attribute block

## Context and Problem Statement

Operaton runs user code at points in an element's lifecycle that never appear as flow nodes.
An execution listener fires when a node starts or ends.
A task listener fires on one of several user task lifecycle events, and one of them, `timeout`, carries its own timer.
Each listener names its event and exactly one binding, a class, an expression, a delegate, or a script, which is the same exactly-one rule a service task binding already carries.

BPMNscript already uses `on` to catch a BPMN event: `on error(E409) { ... }` guards a block, and a boundary form docks that catch onto one activity.
A listener is not a caught event: it never appears in the diagram, and it fires on the element's own lifecycle rather than on something the process throws.
Writing it as `on create(class: "...")` spells that lifecycle callback with the same word a catch uses, so one word covers two ideas.
Whether the listener surface earns its own keyword or reuses `on` and accepts that ambiguity is the first question here.

Three more are settled by the engine rather than by taste, because a shape the surface calls legal has to deploy.
`BpmnParse.parseTaskListeners` accepts six event words, so a surface word for the assignment event that is not the engine's writes an `event` attribute the deployment refuses and cannot read a real file back.
`BpmnParse.parseTimeoutTaskListener` reads the listener's `id` and adds an error when it is null, since the id is baked into the timer job's handler configuration and keys `TaskDefinition.addTimeoutTaskListener`, so a timeout listener needs an id even though no author writes one.
`BpmnParse.checkActivityInputOutputSupported` adds an error for an `operaton:inputOutput` on a `bpmn:subProcess` whose `triggeredByEvent` is `true`, which is exactly where a host-less `on` handler's `input` and `output` lines would lower.
A host-less handler also lowers to two BPMN elements, so a last question follows: which of the two carries the engine attributes written on the statement?

## Decision Drivers

- Every reserved keyword is a name an author permanently loses for a variable or a step, and `listener` is a name a real process might want.
- A listener's shape is fixed by the engine and checkable while typing: one event from a finite set, exactly one binding, a timer only when the event is `timeout`.
- A program the validator accepts must deploy, and a document that deploys must import and rebuild to one that still deploys (ADR-0012).
- One fact about the language lives once: the event words, the parameter hosts and the id scheme are read off one table each.
- The timer clause, the fenced script block, and the `class`, `expression`, and `delegate` keys exist, so reusing them costs less than specifying new forms for listeners.
- No new key on the surface for something the engine derives, and no second spelling to document.

## Considered Options

- Reuse `on` inside the attribute block, letting position decide whether it is a listener or a caught event: the language names one idea once, the timer clause and the bindings carry over unchanged, and nothing is reserved, at the price of a meaning that is positional, so a reader must check what encloses the line.
- Add a distinct `listener <event> { ... }` keyword: the word alone would say the block is an engine callback rather than a flow node, keeping apart two things BPMN itself keeps apart, but it spends a reserved word on an idea the language already has a word for, and every file pays that cost whether or not it registers a listener.
- Spell every event as the engine does, mint the timeout listener's id on export, and refuse parameters on a host-less handler: one spelling per fact, the wire carries it as written, and the id needs no key the author never reads.
- Keep a shorter `assign` on the surface and map it to `assignment` on the wire: one event word would then have two spellings, one in the language and one in every diagram and engine log, and the mapping would be the one place the event table is not the whole truth.
- Give the timeout listener an `id` key, keep the parameter grant, and move the mapping onto the trigger start event: an authored id would survive a round trip, but `BpmnParse.parseStartEvents` calls `ensureNoIoMappingDefined` on every start event, so the nested start cannot take the mapping either, and the key would be the only listener setting the engine derives rather than reads.

## Decision Outcome

Chosen: reuse `on` inside the attribute block, spell every event as the engine does, mint the timeout listener's id on export, and refuse an io mapping on a handler.
`on` already reads as "when this happens, run that" everywhere it appears, and a keyword buys its clarity with a permanently reserved word.
Each of the other three rules follows from one engine method and adds nothing to the surface.

The event word is a soft word, like a trigger word: every task listener event lexes as an identifier, and the validator checks each against the element kind it was written on.
`start` and `end` lex as statement keywords instead, so the grammar names those two as the listener event position's exceptions.
An `on` clause becomes an execution listener or a task listener by its event word alone, since the two event sets never overlap, so the surface never has to spell the distinction the XML draws between `operaton:executionListener` and `operaton:taskListener`.

Every `timeout` task listener is written with the id `<task id>_timeout_<n>`, `n` counting the task's timeout listeners from one in document order.
An id the document already holds is stepped past, the way a synthesized element's id is (ADR-0010).

An `on` handler takes no `input` or `output` line in either form, since the engine refuses a mapping on a boundary event and on an event sub-process alike.
The attribute block rule for a handler therefore grants no parameters, and the validator's existing parameter-host message names the kinds that take one.

Engine attributes on a handler statement land on the element that survives printing.
A hosted handler lowers to one `bpmn:boundaryEvent`, so there is no choice.
A host-less handler lowers to two elements instead, a `bpmn:subProcess` and a nested trigger `bpmn:startEvent`, and its attributes go on the sub-process because the synthesized start event is elided on print.
The timer job's own settings, `jobPriority`, `retryCycle` and `exclusive`, go on that trigger start event instead, since the timer job is the start's, and the printer lifts them back into the head.

### Consequences

- Good, because no word is reserved.
  `listener`, `create`, and `timeout` stay free for a step or a variable name.
- Good, because the timer clause, the script block, and the three binding keys are reused as they stand.
  Highlighting, completion, and the binding diagnostic extend to listeners for free.
- Good, because every program the validator accepts deploys, and a Modeler-authored file with an assignment listener or an id-carrying timeout listener imports without a refusal or a warning.
- Good, because a listener's binding is a list of its own rather than the members every other element carries.
  A listener's block nests no form, no input or output parameter, and no other listener; the one member it holds beside its bindings is an injected field (ADR-0018).
- Bad, because a reader must check the enclosing context to know which `on` they are looking at: inside a task's braces it is a callback, at statement position it is a catch.
- Bad, because a timeout listener's authored id is replaced by the minted one on a round trip, so a document that names its timeout listeners rebuilds under the tool's names.
- Bad, because a value a host-less handler's body needs has to be mapped on a step inside the body rather than on the handler.

### Confirmation

`packages/language/test/validating.test.ts` pins `on assignment` accepted and `on assign` refused with the list, and a parameter on either handler form refused with the parameter-host message.
`packages/transform/test/ir-to-xml.test.ts` pins two timeout listeners on one task written as `_timeout_1` and `_timeout_2`, and the second stepping past a task already holding its id.
`packages/transform/test/xml-to-ir.test.ts` pins `event="assignment"` imported, `event="assign"` refused, and a listener id consumed without a warning.
The frozen pairs `tests/golden/listeners.{bpmnscript,bpmn}` and `tests/golden/input-output.{bpmnscript,bpmn}` carry the three shapes and import without a warning.

## More Information

The intermediate representation carries a listener as an event plus a four-way tagged binding mirroring `ServiceTaskBinding`, and a `timeout` task listener also carries the timer the event layer already models.
Operaton behaviour was read from `BpmnParse.parseTaskListeners`, `BpmnParse.parseTaskListener`, `BpmnParse.parseTimeoutTaskListener`, `BpmnParse.checkActivityInputOutputSupported`, `BpmnParse.ensureNoIoMappingDefined` and `TaskListener`.

Related decisions: ADR-0010 (deterministic structural ids), ADR-0012 (the import contract this surface honors), ADR-0018 (the field a listener's block holds), ADR-0021 (engine attributes as named IR fields).
