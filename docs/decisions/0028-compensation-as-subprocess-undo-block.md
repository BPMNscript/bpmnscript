---
status: accepted
date: 2026-07-18
decision-makers: Marlon Kranz
---

# Compensation as a subprocess undo block

## Context and Problem Statement

BPMN gives a compensation handler two attachment points.
One is a boundary event on the activity being compensated, connected by an association to a separate activity marked `isForCompensation`, an activity that never runs in the normal flow and only executes when compensation reaches it.
The other is a compensation event sub-process, a `bpmn:subProcess` with `triggeredByEvent="true"` whose start event carries a `compensateEventDefinition`, nested directly inside the embedded sub-process it compensates.
The engine treats the two as alternatives for the same intent, reversing the completed work of an activity, but restricts the event-sub-process form to embedded sub-processes, not to a separate process instance a call activity spawns, and caps it at one per sub-process level.
The engine also does not support `waitForCompletion="false"` on a compensation intermediate throw event: the throw always blocks until the triggered compensation finishes, regardless of what the attribute says.
The question this decision settles is which of BPMN's two attachment shapes, or a third designed one, the DSL exposes for compensation, and how throwing compensation fits the `on`/`throw`/`emit` vocabulary the rest of the event layer already uses.

## Decision Drivers

- The engine restricts one of the two BPMN attachment forms, the compensation event sub-process, to embedded sub-processes and one per level; a surface that treats both forms as equally general everywhere would produce documents the engine does not support.
- The audience writes processes without BPMN vocabulary already established for `on`/`throw`/`emit`; a second attachment mechanism, boundary event, association, and a normally-dormant activity, for one event kind breaks the pattern every other trigger kind follows.
- `waitForCompletion="false"` and `activityRef`-targeted throws only matter in combination with boundary-attached handlers; neither has a use once boundary handlers are out of scope.
- The honest import contract (ADR-0012) already distinguishes constructs the DSL refuses from ones it silently drops; a construct this decision does not model needs to land on one side of that line, not the other.

## Considered Options

- Compensation handlers only as a subprocess's `on compensation` block, thrown with the existing `throw`/`emit` pair and no code, which reuses the subprocess construct and the event layer's own vocabulary and matches the engine's restriction to an embedded sub-process, at the cost of one wrapping `subprocess` per step where per-activity granularity is wanted.
- Boundary compensation events with an associated `isForCompensation` activity, which lets a single activity carry its own handler without a wrapper, at the cost of a whole second attachment axis and a kind of activity that is dormant except when triggered, with no equivalent anywhere else in the grammar.
- A throw targeted at a specific activity by name (`activityRef`), which only has a target worth naming once boundary-attached handlers exist to be the targets, and which would need a reference-resolution mechanism the event layer does not otherwise require.
- A dedicated `compensate` verb, kept separate from `emit`, which reads unambiguously as compensation but grows the continuing-throw vocabulary to two words for one behavior, and would have to be a reserved keyword, unlike every trigger name and binding field.

## Decision Outcome

Chosen option: "Compensation handlers exist only as a subprocess's `on compensation` block, thrown with the existing `throw`/`emit` pair and no code", because it keeps compensation inside the vocabulary the rest of the event layer already uses, and the rejected alternatives either duplicate a granularity the subprocess construct already provides or only pay for themselves once that duplication exists.

An undo block lowers to a `bpmn:subProcess triggeredByEvent="true"` nested inside the `bpmn:subProcess` it undoes, whose start event carries a `compensateEventDefinition`.
The at-most-one rule and the container rule are the engine's own restriction rather than a choice of this surface, and a process has no completed enclosing scope to reverse, so `on compensation` at process level is rejected rather than approximated.
Compensation reaches an undo block by two routes: `throw compensation` or `emit compensation` in an enclosing scope, and a cancel end that gives up an enclosing `attempt` block, where Operaton's `CancelEndEventActivityBehavior` throws the compensation itself before handing the run to that block's cancel handler.

Compensation joins `throw`/`emit` on the same terms every other trigger kind already established (ADR-0023).
It carries no code, because compensation has no name to correlate against, unlike error or escalation, so there is nothing for a code string to select.
`emit compensation` always waits for the triggered undo to finish before falling through, matching the engine, which does not honor `waitForCompletion="false"` in the first place; the surface has no attribute for a behavior the engine ignores.

Boundary compensation events, `activityRef`-targeted throws, `waitForCompletion="false"`, and `isForCompensation` activities are all refused on import under the honest import contract (ADR-0012), each with a diagnostic naming the construct rather than a silent drop or an approximation.
When the boundary event and the `isForCompensation` activity are paired through a `bpmn:association`, the diagnostic also names the compensated activity, the boundary event, and the handler, and prints the `subprocess`/`on compensation` rewrite an author would write by hand.

BPMN's boundary-event form exists chiefly to compensate a single activity rather than a whole embedded sub-process.
BPMNscript reaches the same granularity without a second mechanism: wrapping the one step that needs to be undoable in its own `subprocess` gives it its own `on compensation` block, scoped to exactly that step.

### Consequences

- Good, because a saga, several steps, each undoable, unwound in reverse when a later step fails, round-trips through the DSL and executes on the engine using only constructs the surface already has: `subprocess`, `on`, `throw`, `emit`.
- Good, because compensation reuses the same verb pair, the same catch-block reading, and the same container rule every other trigger kind already follows.
- Good, because an import carrying the boundary-event pattern, a targeted throw, or `waitForCompletion="false"` refuses outright, rather than reporting nothing and reproducing a different execution than the one the imported document specifies.
- Bad, because an author porting an existing BPMN model that uses boundary compensation events must restructure it, pulling the compensated activity and its handler into a `subprocess`, rather than have the importer translate the pattern automatically.
- Bad, because per-activity compensation on many independent steps means one small `subprocess` wrapper per step; the surface trades a second attachment mechanism for a per-step wrapping requirement instead.
- Neutral, because compensation's ordering, reverse of execution, invocation count, and the variable snapshot an undo block sees are entirely engine behavior, outside anything this surface models.

### Confirmation

Round-trip coverage in `packages/transform/test` pins an undo block lowering to a nested `triggeredByEvent` sub-process with exactly one `compensateEventDefinition`-carrying start event, `throw compensation` and `emit compensation` lowering to a compensation end event and a compensation intermediate throw without an `activityRef`, and each of the four refused shapes producing a distinct refusal rather than a silently altered import.
`packages/language/test/validating.test.ts` pins the container rule, including the rejection of a second undo block in one `subprocess` or one `attempt`.
Two suites under `tests/e2e/` deploy to a real Operaton and confirm that an undo block executes on a running engine rather than only lowering to the right shape: an `emit compensation` raised by a process-level error handler reaching the undo block of a subprocess that had already completed, and a completed subprocess's undo steps running once the `attempt` block around it is given up.

## More Information

Related decisions: ADR-0029 (work that can be given up, whose cancel end reaches these same undo blocks with no `throw compensation` written anywhere in the source).
