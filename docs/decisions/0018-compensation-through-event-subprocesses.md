---
status: accepted
date: 2026-07-18
decision-makers: Marlon Kranz
---

# Compensation Only as a Subprocess Undo Block: One Handler Form, No Targeted Throws

## Context and Problem Statement

BPMN gives a compensation handler two different attachment points. The first is a boundary
event sitting on the activity being compensated, connected by an association to a separate
activity marked `isForCompensation` — an activity that never runs in the normal flow and only
executes when compensation reaches it. The second is a compensation event sub-process: a
`bpmn:subProcess` with `triggeredByEvent="true"` whose start event carries a
`compensateEventDefinition`, nested directly inside the embedded sub-process it compensates.
The engine's own reference documentation treats the two as alternatives for the same intent —
reversing the completed work of an activity — with the event-sub-process form restricted to
embedded sub-processes (it is not propagated to the separate process instance a call activity
spawns) and capped at one per sub-process level. The engine additionally does not support
`waitForCompletion="false"` on a compensation intermediate throw event: the throw always blocks
until the triggered compensation finishes, regardless of what the attribute says.

BPMNscript already has a subprocess construct and an established `on`/`throw`/`emit` vocabulary
for every other event kind. The question this decision settles is which of BPMN's two
attachment shapes — or a third designed one — the DSL exposes for compensation, and how
throwing compensation fits the verb pair the rest of the event layer already uses.

## Decision Drivers

- The engine itself restricts one of the two BPMN attachment forms (compensation event
  sub-processes) to embedded sub-processes and one per level; a surface that pretends both
  forms are equally general everywhere would produce documents the engine does not actually
  support.
- The audience writes processes without BPMN vocabulary already established for
  `on`/`throw`/`emit`; introducing a second attachment mechanism (boundary event, association,
  a normally-dormant activity) for one event kind breaks the pattern every other trigger kind
  follows.
- `waitForCompletion="false"` and `activityRef`-targeted throws only matter in combination with
  boundary-attached handlers; neither has a use once boundary handlers are out of scope.
- The honest import contract (ADR-0014) already distinguishes constructs the DSL refuses from
  ones it silently drops; a construct this decision does not model needs to land on one side of
  that line, not the other.

## Considered Options

- Compensation handlers exist only as a subprocess's `on compensation` block (a compensation
  event sub-process nested in the `subprocess` it compensates), thrown with the existing
  `throw`/`emit` verb pair and no code
- Boundary compensation events with an associated `isForCompensation` activity, mirroring
  BPMN's other attachment form
- A throw targeted at a specific activity by name (`activityRef`), giving one throw statement
  the ability to compensate a single named unit of work rather than the nearest enclosing scope
- A dedicated `compensate` verb, kept separate from `emit`, for the continuing form

## Decision Outcome

Chosen option: "Compensation handlers exist only as a subprocess's `on compensation` block,
thrown with the existing `throw`/`emit` pair and no code", because it is the only option that
keeps compensation inside the vocabulary the rest of the event layer already uses, and because
the rejected alternatives either duplicate a granularity the subprocess construct already
provides or only pay for themselves once that duplication exists.

**The handler.** A subprocess's undo steps are written directly in its body as
`on compensation { … }` — the steps that reverse whatever that subprocess already finished
doing. `on compensation` lowers to a `bpmn:subProcess triggeredByEvent="true"` nested inside the
`bpmn:subProcess` it undoes, whose start event carries a `compensateEventDefinition`; there is
at most one per subprocess, matching the engine's own restriction. It runs only when something
later throws compensation, and only for a subprocess instance that actually completed — an
instance that never finished has nothing to undo. Because a compensation event sub-process only
exists inside an embedded sub-process, the construct is only legal directly inside a
`subprocess` body; a process cannot compensate itself, so `on compensation` at process level is
rejected rather than approximated.

**The throw.** Compensation joins `throw`/`emit` on the same terms every other trigger kind
already established (ADR-0016): `throw compensation` ends the current path after undoing the
nearest enclosing scope's completed work, `emit compensation` undoes it and continues. Neither
carries a code — compensation has no name to correlate against, unlike error or escalation, so
there is nothing for a code string to select. `emit compensation` always waits for the triggered
undo to finish before falling through, matching the engine, which does not honor
`waitForCompletion="false"` in the first place; the surface has no attribute for a behavior the
engine ignores.

**What is refused, not modeled.** Boundary compensation events, `activityRef`-targeted throws,
`waitForCompletion="false"`, and `isForCompensation` activities are all refused on import under
the same contract ADR-0014 already established for constructs the DSL cannot express without
changing what the process does. None of the four is silently dropped or approximated by the
nearest `on compensation` equivalent; an import encountering any of them stops with a
diagnostic naming the construct.

**Per-activity undo.** BPMN's boundary-event form exists chiefly to compensate a single activity
rather than a whole embedded sub-process. BPMNscript reaches the same granularity without a
second mechanism: wrapping the one step that needs to be undoable in its own `subprocess` gives
it its own `on compensation` block, scoped to exactly that step. A single task that needs an
undo path becomes a named unit of work with its own undo block — the same construct already
used everywhere else compensation applies, at whatever granularity the author needs.

### Consequences

- Good, because a saga — several steps, each undoable, unwound in reverse when a later step
  fails — round-trips through the DSL and executes on the engine using only constructs the
  surface already has: `subprocess`, `on`, `throw`, `emit`.
- Good, because compensation reuses the same verb pair, the same catch-block reading, and the
  same container rule every other trigger kind already follows; there is nothing new to learn
  beyond "undo block" and "no code."
- Good, because an import carrying the boundary-event pattern, a targeted throw, or
  `waitForCompletion="false"` refuses loudly instead of silently reproducing a different
  execution than the one the imported document actually specifies.
- Bad, because an author porting an existing BPMN model that already uses boundary compensation
  events must restructure it — pulling the compensated activity and its handler into a
  `subprocess` — rather than have the importer translate the pattern automatically.
- Bad, because per-activity compensation on many independent steps means one small `subprocess`
  wrapper per step; the surface trades a second attachment mechanism for a per-step wrapping
  requirement instead.
- Neutral, because compensation's ordering (reverse of execution), invocation count, and the
  variable snapshot an undo block sees are entirely engine behavior — ADR-0016's "nothing here
  to model" reasoning for escalation delivery applies the same way to compensation ordering.

### Confirmation

Round-trip coverage in `packages/transform/test` pins a subprocess with an `on compensation`
block lowering to a nested `triggeredByEvent` sub-process with exactly one
`compensateEventDefinition`-carrying start event, and `throw compensation`/`emit compensation`
lowering to a compensation end event and a compensation intermediate throw respectively, both
without an `activityRef`. Refusal coverage in the same suite pins a boundary compensation event,
an `activityRef`-targeted throw, `waitForCompletion="false"`, and an `isForCompensation`
activity each producing a distinct refusal rather than a silently altered import.
`packages/language/test/validating.test.ts` pins the container rule: `on compensation` directly
inside a `subprocess` body validates, the same block at process level or inside an
`if`/`while`/`parallel` branch is rejected, and a second `on compensation` block in one
subprocess is rejected as a duplicate.

## Pros and Cons of the Options

### Compensation handlers only as a subprocess `on compensation` block

- Good, because it reuses the subprocess construct and the `on`/`throw`/`emit` vocabulary the
  rest of the event layer already established, instead of adding a second attachment mechanism
  for one event kind.
- Good, because it matches the engine's own restriction — a compensation event sub-process is
  only legal inside an embedded sub-process — rather than pretending a broader form exists.
- Bad, because per-activity compensation costs a wrapping `subprocess` per step instead of a
  boundary event attached directly to the step.

### Boundary compensation events with an `isForCompensation` associated activity

- Good, because it lets a single activity carry its own compensation handler without wrapping
  it in a subprocess.
- Bad, because it is a whole second attachment axis — a boundary event, an association, and an
  activity that never runs in the normal flow — for a granularity level the wrap-in-`subprocess`
  pattern already reaches with constructs the surface already has.
- Bad, because it introduces a kind of activity (`isForCompensation`, dormant except when
  triggered) with no equivalent anywhere else in the grammar, breaking the rule that every
  construct maps to something the author writes and runs directly.

### A throw targeted at a specific activity by name (`activityRef`)

- Good, because it lets one throw compensate a single named unit of work rather than everything
  the nearest enclosing scope completed.
- Bad, because it only has a target worth naming once boundary-attached handlers exist to be the
  targets — with those rejected, there is nothing distinct for `activityRef` to select beyond
  the nearest enclosing scope `throw compensation` already reaches.
- Bad, because naming an activity across scope boundaries needs a reference-resolution
  mechanism the grammar does not otherwise require anywhere else in the event layer.

### A dedicated `compensate` verb, separate from `emit`

- Good, because a compensation-specific verb name reads unambiguously as compensation rather
  than sharing a word used for escalation and signal.
- Bad, because it grows the event layer's continuing-throw vocabulary to two words (`emit`,
  `compensate`) for one behavior — fire and continue — that `emit` already spans for every
  other trigger kind with a continuing form.
- Bad, because it would need to be a reserved keyword to avoid ambiguity with `emit`, unlike
  every trigger name and binding field, which stay soft identifiers precisely so the audience's
  ordinary variable names keep working.

## More Information

Related decisions: ADR-0013 (the target audience and the no-boilerplate rule — the reason a
wrapping `subprocess` is preferred over a second attachment mechanism for per-activity
granularity). ADR-0014 (the honest import contract — the reason boundary compensation events,
`activityRef`-targeted throws, `waitForCompletion="false"`, and `isForCompensation` activities
are refused rather than approximated). ADR-0016 (the `throw`/`emit` terminality rule and the
soft-word design — compensation reuses both without adding a reserved word or a
position-dependent reading). ADR-0017 (the trigger-payload design — compensation is the one
trigger kind whose payload is empty, since it has no code, name, or condition to carry).

Extended by ADR-0019 (boundary events attached to an activity), which adds the attachment axis for six other trigger kinds while leaving this decision intact: compensation is still reachable only as a subprocess undo block, and a compensation boundary event is still refused on import.
