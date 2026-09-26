---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Operaton engine attributes as named IR fields

## Context and Problem Statement

The importer reports everything it cannot represent in the `extensionAttribute` warning category, and Operaton's execution settings all land there: `asyncBefore` and its siblings, job priority, the retry cycle, `operaton:inputOutput`, execution and task listeners, and every user-task assignment attribute beyond `assignee` and `formKey`.
A process that round-trips through this tool comes out without them, which makes the tool unusable on a file a real deployment produced.
None of these settings changes control flow: an async continuation decides where the engine commits a transaction, an input parameter decides what a delegate reads, and a listener decides what runs alongside a step.
Carrying them needs no change to gateway synthesis, only somewhere to put roughly twenty values and a mapping on each of the four transforms.

Two carriers make the placement question harder than one field per node.
A gateway is the one flow node in this surface with no keyword and no name of its own, since `if`, `while`, `do...while`, `parallel`, and a multi-branch `await` each synthesize one or two from block structure and the restructurer elides every one it matches back to a statement.
Operaton still reads five execution settings off every gateway it deploys, and a file a real deployment produced can set any of the five on any of its gateways.
A timer's job settings are not all read off the node that carries the timer either: `BpmnParse.parseTimer` builds the job a timer creates from `operaton:exclusive` on the `bpmn:timerEventDefinition` element and from the priority stored on the activity that carries the definition.

Where should these settings live in the IR, under what names, which elements can take which, and which element does each one get written on?

## Decision Drivers

- The IR's shape and its no-vendor-prefix naming convention (ADR-0007), which twenty fields arriving at once have to fit rather than amend.
- The validator checks attribute keys against element kind, and round-trip idempotence compares IR against IR, so a carried setting has to be a typed field a structural comparison can see, not opaque text.
- Three settings are not flat: an input or output parameter's value can be a list, a map, or an inline script, and a listener carries an event plus one of four bindings.
- A setting the script writes must reach the job it names, and the surface keeps one `exclusive` key per statement rather than one key per job an element may create.
- Every gateway is still synthesized and matched back, so a setting cannot cost a gateway its textual anonymity.
- The one bracket shape already holds scalar settings in a parens, and a join gateway sits beside its split under one statement, so the two need told-apart spellings inside one parens rather than a second parens.
- The import contract: what changes execution is refused, what does not is carried or warned, and nothing drops in silence.

## Considered Options

- Named vendor-neutral fields on the IR node, which extend what the IR already does for `assignee`, `formKey`, and the service-task binding and let the type system do the validation work, since a listener's binding is a tagged union of four variants and one with two bindings or none cannot be constructed.
  A setting nobody has named yet is not carried, so keeping up with the engine means editing code rather than widening a container.
- A generic extension bag keyed by qualified attribute name, filled from import and written back verbatim, which would carry every Operaton attribute at once, including ones nobody has looked at, but implies an untyped DSL surface where any key compiles and a typo produces an attribute the engine never reads and never complains about.
- Openly `operaton:`-prefixed field names such as `operatonAsyncBefore`, which would show a reader which fields are BPMN's own and leave room for a second engine, but contradict the naming rule already set (ADR-0007), since `assignee`, `formKey`, and the service-task binding are engine settings under plain names, so a prefix means renaming them or keeping two conventions in one file.
- A gateway's settings in a parens on the statement head, the join's under a `join`-prefixed spelling, reusing the bracket shape every element already has at no grammar cost beyond a settings slot on five statement rules and putting the join's setting next to the split's, at the price of ten keys a reader tells apart by prefix alone.
- A second parens for the join gateway, which would need no prefix, but puts two adjacent parens on a statement head, a shape nothing else in the grammar has, and leaves the second one empty on `while`.
- A `gateway` keyword introducing an authored gateway that carries a setting the way any other named element does, which reserves a word for an element the grammar deliberately keeps unauthored, and an authored gateway gains an id, stops eliding, and breaks the restructurer's round trip.
- Each timer job setting written on the element the engine reads it from, so the documented spelling runs as written with no new key and no warning, at the price of the lock being written in two places on a timer carrier with an async flag, the one shape that can disagree with itself.
- A warning on a host-less timer handler's job settings, pointing the author at an explicit `start` inside the body, which leaves a documented spelling unable to reach the job it names and answers with a warning.
- A second surface key for the timer job's lock, beside the one for the continuation job, which spends a key on a distinction the element the engine reads already makes, and would put one lock key per job on every statement.

## Decision Outcome

Chosen options: named vendor-neutral fields on the IR node, a gateway's settings in a parens on the statement head, and each timer job setting written on the element the engine reads it from.
The IR already carries `assignee`, `formKey`, and the service-task and call-activity bindings under plain names, so the naming extends a precedent rather than amending one.

Each setting becomes an optional field on the IR node that owns it, named for what it means rather than how it serializes, so the retry cycle is `retryCycle`, not `failedJobRetryTimeCycle`.
Flow-node settings group into one mixin interface and input/output into a second, both as tagged unions so an illegal combination is unrepresentable: `JobSettings` carries the five job settings alone, and `EngineAttributes` is the wider mixin that adds listeners, for everything that keeps a textual identity to attach one to.
The naming rule holds at the boundary: values are stored under plain names, and `irToXml` adds the `operaton:` prefix at the one point where it builds the moddle element.

The engine reads the five off a gateway as it does off an activity.
`BpmnParse.parseExclusiveGateway`, `parseInclusiveGateway`, `parseParallelGateway`, and `parseEventBasedGateway` each call `parseAsynchronousContinuationForActivity` for `asyncBefore`, `asyncAfter`, and `exclusive`, and `createActivityOnScope` for `jobPriority` through `parsePriority`, while `DefaultFailedJobParseListener.parseActivity` reads the retry cycle the same way.
A gateway has no textual identity to hang an attribute on, so its five settings are authored in a parens on the head of the statement that synthesizes it, the split's under their plain spelling and the join's under `join` plus the spelling.
One parens rather than two, because a statement already reads as one construct, and a second parens would ask an author to place a setting on a gateway they cannot see or name.
Execution listeners stay off every gateway kind, since there is nothing there to attach one to.

`parseEventBasedGateway` refuses `asyncAfter` on the gateway it deploys, so a multi-branch `await` head refuses the same setting and an import carrying it throws `UnsupportedEventFeatureError` rather than importing a document that never deployed.
`joinAsyncAfter` is unaffected, since the join a race falls through to is an ordinary exclusive gateway.
The printer recovers a gateway's settings onto the statement head it prints them under, and a gateway that reaches no head, an unstructured jump target or a degraded split among them, loses them under the `droppedSetting` warning.

A timer's job settings follow the same rule, each written on the element the engine reads it from.
`DefaultFailedJobParseListener.parseStartEvent`, `parseBoundaryEvent` and `parseIntermediateCatchEvent` read the retry cycle off the event element when its type is a timer, while `operaton:exclusive` on the event tag is read by `BpmnParse.parseAsynchronousContinuation` alone, which configures the async continuation job, and with no async flag there is no such job.
A node carrying a timer therefore writes its `exclusive` on the `bpmn:timerEventDefinition` as well as on the event tag: the definition's copy locks the timer job, the tag's copy the continuation job an async flag creates.
The moddle descriptor declares the attribute on the definition, so it parses as a typed boolean and the default `true` is omitted on write.

A host-less `on timer(...)` handler lowers `jobPriority`, `retryCycle` and `exclusive` onto the trigger start event it synthesizes, and `asyncBefore` and `asyncAfter` onto the event sub-process, whose continuation job they create, since nothing that creates a timer job looks at the sub-process.
The printer lifts the three back into the `on timer` head as long as the start prints no statement of its own, and leaves them on the `start` line when it does, so an authored start inside the body keeps its settings where it wrote them.
Every other host-less handler writes its settings on the event sub-process.

### Consequences

- Good, because the validator can restrict attribute keys per element kind, and the vendor prefix stays on the serialization boundary, so the IR reads the same regardless of whether the reader knows Operaton.
- Good, because the IR stays a typed model: a field on a user task but not a start event is a compile error at every call site, and a round-trip comparison sees a field rather than a string to parse.
- Good, because a file a real deployment produced imports its gateway settings instead of losing them, and the two `asyncAfter` refusals, on a wait's head and on import, agree with each other and with what Operaton itself refuses to deploy.
- Good, because `exclusive: false` on a timer start, a hosted timer, an `await timer` and a host-less timer handler configures the job the timer creates, and a host-less `on timer` with `jobPriority` or `retryCycle` deploys a job that carries them.
- Bad, because every engine setting is a mapping surface on all four transforms: a grammar key, a validator entry, a lowering, an XML mapping, an import read, and a printer case.
- Bad, because a setting Operaton supports and the IR does not name is dropped with a warning rather than carried.
- Bad, because ten keys sit in one parens on three statement kinds, so a reader has to know which five are the join's before knowing which gateway a value tunes.
- Bad, because a gateway that never reaches a statement loses its settings on print; `droppedSetting` reports the loss rather than preventing it.
- Bad, because a timer carrier with an async flag writes `operaton:exclusive` twice, and a document that sets the two apart imports with one of them changed and a warning.

### Confirmation

The `gateway-settings` golden pair under `tests/golden` carries all five plain and all five join-prefixed keys, both `parallel` element kinds included, and its suite asserts the settings survive DSL to XML to DSL and back; the frozen pair `tests/golden/engine-attributes.{bpmnscript,bpmn}` carries the lock on the hosted timer's definition.
The validator table in `packages/language/test/validating.test.ts` pins the loop and `await` refusals and the pruned-join warning.
`packages/transform/test/operaton-moddle.test.ts` pins the typed attribute on the definition and its omission at the default, and `packages/transform/test/ir-to-xml.test.ts` pins the definition and the tag both carrying the lock on a boundary timer and an await, and neither when none is written.
`packages/transform/test/xml-to-ir.test.ts` pins the gateway carry, the `asyncAfter` refusal, the definition's value on a boundary and an event sub-process start, the tag's as the fallback, the one warning when the two differ, and the warning under which a timer-started event sub-process's own timer job key is dropped.
`packages/transform/test/ast-to-ir.test.ts` and `packages/transform/test/ir-to-dsl.test.ts` pin the three settings on the synthesized start, the async flags on the sub-process, the lifted head, the authored start keeping its own line, and `droppedSetting`.

## More Information

Each field's serialized form is documented beside its declaration in `packages/transform/src/ir/types.ts`, where the five job settings sit beside `JobSettings`, and the prefix is applied only in `packages/transform/src/ir-to-xml.ts`.
The join spellings are derived at `JOIN_KEY_BY_ENGINE_KEY` and the statements that take them are listed at `GATEWAY_STATEMENT_RULES`, both in `packages/language/src/vocabulary.ts`.
The timer behaviour was read from `BpmnParse.parseTimer`, `BpmnParse.parseAsynchronousContinuation`, `BpmnParse.createActivityOnScope` and `DefaultFailedJobParseListener.parseStartEvent`.
ADR-0007 sets the IR shape and the naming rule this decision applies.
