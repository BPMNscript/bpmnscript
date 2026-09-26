---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Mirror the engine's parse-time rules in the validator

## Context and Problem Statement

`BpmnParse` refuses a set of documents at deployment that this surface compiled without a word.
`addEventSubscriptionDeclaration` keeps one message or signal subscription per name on one scope, and one conditional start per condition text on the process.
A handler written inside a block subscribes on that block, since the event sub-process it lowers to takes the block as its event scope (`parseEventDefinitionForSubprocess`), and a handler attached to the block subscribes on the block too (`parseBoundaryEvents`), so the two collide on one name.
Every branch of an `await` block subscribes on the gateway (`parseIntermediateCatchEvent`), so two branches on one name collide as well.
`addEscalationEventDefinition` refuses an escalation catch without a code beside one with a code when both are boundary events on one host or both event sub-processes in one scope.
`selectInitial` refuses a second plain or timer start on a process, a rule ADR-0034 chose not to mirror.
The validator keyed a handler by its host name and grouped handlers by syntactic container, so none of these collisions drew a diagnostic, and the deployment failed with an engine message naming a generated id.

Three more facts sit beside those, silent rather than refused.
`parseScopeStartEvent` reads neither `operaton:initiator` nor a start form off a start that is not the process's own, so both compiled onto a nested start and did nothing.
`DefaultFailedJobParseListener.parseActivity` stores a retry cycle only for an activity with an async flag, and `parseAsynchronousContinuation` folds `exclusive` into the async flags it sets.
`createActivityOnScope` stores a job priority that only a job declaration reads.
Each of the three keys therefore configures nothing without the job its async flag creates.
`parseServiceTaskLike` hands `resultVariable` to an `expression` binding alone, so the setting beside `topic` or `type` writes no variable.

Which of the engine's parse-time rules should the validator repeat, and how should a setting the engine never reads be reported?

## Decision Drivers

- A document the validator passes should deploy, and a refusal should reach the author on the line that caused it rather than as an engine message naming a generated id.
- A setting that configures nothing is a mistake the author cannot see on the page, since the document deploys and runs.
- Every mirrored rule cites the engine method it repeats, so a reader can check it against the engine's source when the engine moves.

## Considered Options

- Mirror each parse-time refusal in the validator and warn on each setting the engine never reads
- Leave the refusals to the engine and document them
- Mirror the refusals and refuse the unread settings too

## Decision Outcome

Chosen option: mirror each parse-time refusal in the validator and warn on each setting the engine never reads.
A refusal the engine makes is a fact the page can state on the right line, and a setting that does nothing leaves the process running, which is a warning's severity.

The validator groups handlers by the scope the engine subscribes them on: the host of a boundary event, or the container an event sub-process sits in.
Within one scope a message or signal name is refused twice among boundary and event sub-process catches, so a handler inside `Sub` and one attached to `Sub` collide; a process start of the same name is keyed apart (`hasMultipleEventDefinitionsWithSameName` compares the start flag too) and sits beside either.
A boundary on a repeated host subscribes on the multi-instance body, one scope above the host's own (`getMultiInstanceScope`), so a name inside such a host stays free.
An escalation, error, or cancel catch is compared against catches of its own kind alone, and an escalation catch-all beside a coded catch of its kind is refused.
The `on error` case stays refused as this surface's own rule, and its message says so: `addErrorEventDefinition` sorts the definitions and the runtime takes the first match.
Two branches of one `await` block on one message or signal name are refused.
On a process, a second plain or timer start, a second message or signal start of one name, and a second condition start of one rendered condition text are refused; the two warnings ADR-0034 introduced stay.
A start inside a subprocess, an attempt block, or a handler body refuses `initiator` and a `form` block.

`retryCycle`, `exclusive`, or `jobPriority` written without `asyncBefore` or `asyncAfter` of the same spelling family draws a warning saying it configures no job; `join*` pairs with `join*` and `run*` with `run*`.
On a repeated step the step's own `retryCycle` and `exclusive` pair with `asyncBefore` and `asyncAfter`, the whole-loop job, while `runRetryCycle`, `runExclusive`, and `jobPriority` pair with `runAsyncBefore` and `runAsyncAfter`, the per-run jobs.
`jobPriority` sits with the per-run keys because `parseActivity` swaps the scope to the multi-instance body before `createActivityOnScope` stores the priority, so it lands on the inner activity and prices each run's job.
The body itself is created without one, and its job takes the process's priority.
A timer carrier is exempt for all three, since the timer job reads them off the event element (ADR-0047).
`resultVariable` beside `topic` or `type` draws the same kind of warning, since nothing writes the variable.

### Consequences

- Good, because a script that compiles now deploys where these rules are concerned, and the message names the scope and the engine method.
- Good, because a setting that configures nothing is reported at the key that carries it.
- Bad, because the validator restates engine rules that can move under a new engine version; each rule cites the method it mirrors so the drift can be checked.
- Neutral, because a script written before this decision with a nested start form, an unpaired job setting, or a `resultVariable` beside `topic` now draws a diagnostic where it drew none.

### Confirmation

`packages/language/test/validating.test.ts` holds a row per rule: a handler inside a block beside a boundary on it per trigger, the repeated-host exemption, the escalation pairs both ways and the legal mix, two race branches on one name, each duplicate start kind, `initiator` and a form on a start in each of the three containers, each job setting key with and without its flag on each carrier, and `resultVariable` beside each binding.

## More Information

Amends ADR-0034, which declined to mirror `selectInitial`; a second plain or timer start is now an error.
Amends ADR-0041, whose "no `runJobPriority`" rule stands while the reason moves: `jobPriority` on a repeated step prices each run's job rather than the whole loop's.
Amends ADR-0042 and ADR-0043, under which `resultVariable` beside `topic` or `type` was accepted and ignored; it now warns.
Operaton behaviour was read from `BpmnParse.addEventSubscriptionDeclaration`, `parseEventDefinitionForSubprocess`, `parseBoundaryEvents`, `getMultiInstanceScope`, `parseIntermediateCatchEvent`, `addEscalationEventDefinition`, `addErrorEventDefinition`, `parseBoundaryCancelEventDefinition`, `selectInitial`, `parseScopeStartEvent`, `parseProcessDefinitionStartEvent`, `parseStartFormHandlers`, `parseAsynchronousContinuation`, `parseActivity`, `createActivityOnScope`, `parseServiceTaskLike`, and `DefaultFailedJobParseListener.parseActivity`.

Related decisions: ADR-0019 (boundary events), ADR-0023 (host-less handlers as event sub-processes), ADR-0025 (the `await` block), ADR-0034 (several starts on a process), ADR-0040 (job settings on gateways), ADR-0047 (timer job settings on the element the engine reads).
