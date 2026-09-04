---
status: accepted
date: 2026-07-23
decision-makers: Marlon Kranz
---

# Boundary Events Attached to an Activity: Host Syntax, Trigger Scope, and a Self-Contained Body

## Context and Problem Statement

Every `on` handler in BPMNscript compiles to an event sub-process that guards its whole enclosing process or subprocess body (ADR-0016).
BPMN has a second, narrower attachment for the same catch vocabulary: a `bpmn:boundaryEvent` docked directly on one activity, which only catches while that activity is running and, depending on `cancelActivity`, either cancels it the moment the trigger fires or lets it keep running alongside the catch.
Giving `on` an optional host turns it into this second attachment form without introducing a competing keyword or a second handler construct.

Four questions have to be settled together, because each interacts with a decision already recorded for the host-less handler.
How is a host spelled without colliding with a handler shape that already exists (`on timer after "PT2H"`)?
Which of the language's eight catchable triggers may attach as a boundary event, and what happens to the two this decision does not admit?
What does a hosted handler's body compile to, given that the host-less form's meaning must stay exactly what ADR-0016 already fixed it to be?
And how is a token that appears directly at a boundary event, without ever traversing the main flow, represented in the dominator-based restructuring analysis (ADR-0009) that turns flat IR back into structured DSL?

## Decision Drivers

- The grammar already commits every trigger word to being a soft identifier (ADR-0016), so a new syntax slot cannot recover disambiguation from the trigger word's token type, only from structure the grammar itself contributes at parse time.
- The host-less `on` handler's meaning, an event sub-process, is exercised by existing golden fixtures and must not move: a hosted handler is a new attachment form layered next to it, not a replacement for it.
- Operaton's own parser (`BpmnParse.parseBoundaryEvents`) is the actual authority on which triggers, and which host shapes, a boundary event may legally carry; a surface stricter than the engine owes a reason.
- The restructuring analysis (ADR-0009) already commits to being total over every valid IR.
  A boundary event is the IR's first flow-element shape with outgoing edges but no incoming ones, a shape the analysis has never had to reason about, so the decision has to say explicitly what that shape means for reachability and dominance, not leave it implicit.
- The honest import contract (ADR-0014) and the compensation decision (ADR-0018) both carry commitments this feature must not invalidate: no silent mangling on import, and compensation stays a subprocess undo block rather than gaining a second attachment mechanism.

## Considered Options

For the host separator:

- A colon between host and trigger (`on Pack: error "X"`)
- A bare space (`on Pack error "X"`)
- A postfix clause (`on error "X" at Pack`)

For the trigger scope:

- All eight of the language's catchable triggers as boundary events
- Every trigger but compensation and cancel
- A smaller hand-picked subset

For the body shape:

- The body lowers inline into the host's container and rejoins the main flow only through an explicit `goto`
- The body falls through to whatever statement follows the host
- The body is wrapped in a container of its own, the way a host-less handler already is

For the CFG treatment:

- A boundary event is wired to the restructuring analysis's virtual entry like a start event
- It is left unwired entirely
- It is made the root of a second analysis run over the same container

For the id scheme:

- The boundary event's id is derived from the host and the trigger
- It reuses the positional `EventSubProcess_<X>` scheme already used for host-less handlers

## Decision Outcome

Five related decisions, chosen together because each keeps the same host-less meaning intact wherever the new attachment form does not have to touch it, and spends new syntax, a new reserved word, or a new pass only where an alternative would either misparse an existing form, mangle an import, or leave an escape chain permanently unreadable by the restructurer.

The colon separator.
A hosted handler is written `on Pack: error "X" { ... }`: the host name, a colon, then the trigger exactly as a host-less handler already writes it.
The bare form originally proposed, `on Pack error "X"`, is provably ambiguous with a handler that already parses today, `on timer after "PT1H"`: both are, at the token level, `ID ID STRING`, because every trigger word and every timer particle lexes as a plain identifier by deliberate design (ADR-0016) rather than as a grammar keyword.
The ambiguity sits in the token text, not the token type, so no amount of lookahead over token types can tell `Pack error` (host, trigger) apart from `timer after` (trigger, particle).
Only the words themselves would, and reserving them as keywords is exactly what ADR-0016 already ruled out.
The colon resolves the ambiguity at the second token, before either reading has to be committed to: plain two-token lookahead already suffices, well inside what Langium's default parser handles without any special grammar annotation.

Rejected, having been worked through directly: promoting the eight trigger words to real keywords and then re-admitting them as ordinary identifiers through a data-type escape hatch, so `var message: string` keeps parsing.
This alternative does work, but at a cost disproportionate to what the colon buys for free.
Every site in the grammar that currently accepts a soft trigger word as an identifier would need a parallel keyword-or-identifier rule, some two dozen individual grammar productions, which reopens the soft-trigger-word decision ADR-0016 already closed for reasons unrelated to boundary events.
It also does not fully remove the ambiguity: the grammar generator still reports a residual ambiguous alternative between the keyword-led host form and the timer form, resolved by picking whichever alternative the generator orders first and reported only as a warning on the build's stderr, a resolution an author has no visibility into and that a future grammar edit could silently invert.
The colon leaves no such residual: it is a structural token the grammar decides on unambiguously, not a policy the generator applies silently.
Also rejected: a postfix host clause, `on error "X" at Pack`, which reuses the word `at` that a timer's particle clause already claims (`on timer at "2026-08-01T09:00:00"`), reopening the exact kind of two-reading collision the colon exists to avoid, just moved to a different position in the handler.

The six-trigger scope.
Message, timer, signal, and conditional boundary events are interrupting or non-interrupting (`alongside`) on any activity.
Error is always interrupting, on any activity, reusing the same `alongside: false` restriction already enforced for a host-less error handler rather than adding a boundary-specific rule.
Escalation is interrupting or non-interrupting but only on a subprocess, an `attempt` block, a call, or a user task.
Operaton gates that boundary on `attachedActivity.isSubProcessScope()`, and `parseTransaction` sets that flag exactly as `parseSubProcess` does, so an `attempt` block hosts an escalation on the same terms an ordinary block does.
These restrictions are read from Operaton's own boundary-event parsing rather than invented, so every boundary event the surface admits is one the engine deploys; where the surface is stricter than the engine, as it is for error's cancellation mode and for compensation, this decision says why.

Compensation is excluded on the grounds ADR-0018 already established for it generally: BPMN attaches compensation through a `bpmn:association` and an `isForCompensation` activity, a different attachment mechanism entirely.
This exclusion preserves ADR-0018's decision rather than superseding it, since `on compensation` remains only a subprocess's own undo block, never a boundary form.
It also keeps the import-side `refuseIfForCompensation` guard honest for exactly the reason ADR-0018 gives it: an activity marked `isForCompensation` still can never run, because a `bpmn:BoundaryEvent` carrying a `compensateEventDefinition` is refused on import just as it always was, now as one specific refusal inside a boundary event's own import path rather than as a blanket "no boundary events at all" rule.
Cancel is excluded from these six because Operaton allows a cancel boundary on a transaction alone; ADR-0028 surfaces that container as the `attempt` block and admits one there.

The self-contained body.
A hosted handler's body lowers inline into the same container as its host, with no wrapping sub-process, as a boundary event followed by the body's own statement chain, terminating in the chain's own implicit end event.
The only way back into the main flow is an explicit `goto`, uniform across interrupting and non-interrupting handlers alike, matching what a bare `{ }` block already means everywhere else in the language: a scope ends where its last statement ends, unless something inside it names where control goes next.

Rejected: falling through to whatever statement follows the host in the main flow.
This reads correctly for a "retry, then continue" shape on an interrupting boundary, but it is wrong by default for a non-interrupting (`alongside`) one: the host's own token is still running the main flow forward at the same time the escape chain would also be falling into it, duplicating the token and running the rest of the process twice.
A single body shape that is correct for both interrupting and non-interrupting boundaries, with rejoining always spelled out by the author, avoids a rule that would otherwise have to special-case `alongside`.

The transparency rule, and a consequence it has that the author cannot see.
Because a hosted handler's body is not its own container, the scope provider's flow-container walk (the same walk that decides what `goto` may resolve against) has to treat a hosted `on` as transparent: resolving a name from inside such a body walks straight past the handler to the real enclosing process or subprocess, exactly as if the hosted `on` were not there at all.
This is what makes `goto` legal in both directions across a hosted handler's body, both a `goto` inside the body reaching a main-flow statement and a main-flow `goto` reaching into the body, because both resolve against the one container the lowering actually places their statements in.

This same transparency has a consequence a program's author has no way to observe from the source text alone, and it has to be recorded as a decision rather than left to be discovered as a surprise.
A host-less `on` written inside a hosted handler's body is not scoped to that escape path.
Because the hosted handler contributes no container of its own, a host-less handler nested inside it lowers into the same outer container its host lives in, the process or subprocess the hosted handler is itself attached to, and therefore guards that whole outer container, not just the one escape path it is textually written inside.
The result is valid BPMN that Operaton deploys without complaint, and it follows directly and necessarily from treating a hosted handler as transparent; it is not a bug in the lowering.
But it widens what a nested handler guards invisibly, purely as a side effect of where it happens to be written, and an author reading only the source has no local signal that this widening occurred.

Boundary events as a second entry into the control-flow graph.
The restructuring analysis wires every boundary event to its container's virtual entry, unconditionally, the same way it already wires every start event.
This is the honest model, not a workaround: at runtime, a token genuinely appears at a boundary event the moment its trigger fires while its host is running, without ever traversing a sequence flow into it.
Without this wiring, a boundary event's whole escape chain has no immediate dominator at all, and the restructurer can recognize an `if`, a `while`, or a clean join only relative to a dominance relationship, so an escape chain with no path from the entry could never be recognized as anything but a sequence of unstructured `goto`s.

The accepted trade-off: a node reachable from both the main flow and an escape chain loses a tight immediate dominator once the boundary event is wired in.
Its dominator moves up to the shared virtual entry, since neither the main flow's split nor the escape chain alone reaches it unconditionally.
An `if`/`else` whose join such an escape chain jumps into therefore degrades to plain `goto`s on decompile rather than printing as a structured branch.
The dominance result itself is correct: a region two independent entry points can both reach is genuinely not dominated by either one's split, so printing it as `goto`s is the restructurer being honest about a graph shape it cannot losslessly re-fold into `if`/`else`.

The degraded output is not always re-readable, though, and the limit is worth stating precisely.
When the join the chain lands on is a synthesized gateway rather than an authored step, the emitted `goto` names an id that has no statement form, so the printed source carries an unresolved-reference diagnostic and does not re-desugar to the graph it came from.
That is a property of the `goto` sweep and not of the attachment axis, since the same output arises from a boundary-free program whose `while` body ends in a `goto` into an `if` branch, but an escape chain rejoining a branch join is a natural second way to reach it.
Decompiling a hand-drawn diagram of that shape yields source a reader must repair by hand.
Rejected: leaving a boundary event unwired, which makes every escape chain permanently un-restructurable regardless of how simple its own internal control flow is; and running a second, boundary-rooted analysis over the same container, which the restructurer's single-`Emitter`-per-container design does not support, since two independent analyses over one shared node/edge set would have no way to agree on which of them owns a node reachable from both.

Host-derived ids.
A boundary event's id is `Boundary_<hostId>_<trigger>`, collision-resolved against the same document-wide `taken` set the implicit start/end ids already share, rather than the positional `EventSubProcess_<X>` scheme a host-less handler's event sub-process already uses.
Both halves of this id, the host's authored name and the trigger word, are text the author wrote and that survives a round trip verbatim, so the id does not move when the decompiler reorders handlers to the end of a container's statement list the way the trailing-position rule requires.
A positional id would drift the moment that reordering happened, exactly the instability the existing `normalizeIr` re-key already has to canonicalize away for event sub-processes; a host-derived id needs no equivalent re-key for the generation direction at all.

The one case this id scheme does not fully disambiguate is two boundary handlers sharing a host and a trigger but differing in code.
`on Pack: error "A"` and `on Pack: error "B"` are legal, non-duplicate handlers under the validator's `(host, trigger, code)` key, yet both base to the identical `Boundary_Pack_error` before collision suffixing runs, so which one keeps the bare id and which one receives the `_2` suffix is positional rather than derived from either code.
This is stable in the generation direction, since lowering assigns suffixes in statement order, the decompiler reprints handlers in that same order, and re-lowering reproduces it.
It is exposed on import, though, where a hand-written or externally modeled document may present the two boundary events in whatever order the tool that wrote them chose.
Folding the code into the base id was rejected: no other id constructor in this scheme sanitizes arbitrary author-supplied text into an id fragment, and doing so here would still need a numeric suffix for the case where two boundaries share every distinguishing property outright (two `timer` boundaries on one host, which carry no engine subscription key and so are never rejected as duplicates).
The round-trip normalizer compensates on the comparison side instead: its canonical-id function keys a boundary event's signature on the event definition's own payload, not on the printed id, so two IR snapshots compare equal regardless of which physical id each assigns to which occurrence.

### Consequences

- Good, because the colon resolves the host/trigger ambiguity with no reserved word, no residual parser-generator warning, and no change to ADR-0016's soft-trigger-word design.
- Good, because the six-trigger scope admits only what Operaton's own parser accepts, so a boundary event the validator passes always deploys.
  The converse does not hold: a compensation boundary is refused on ADR-0018's attachment-mechanism grounds rather than on an engine refusal, and Operaton would deploy the document that refusal rejects.
- Good, because excluding compensation costs nothing new to build: the existing `on compensation` undo block already covers the granularity a boundary compensation event would have reached, and the import-side refusal that keeps `isForCompensation` honest needed no new mechanism, only a new call site for the existing one.
- Good, because the self-contained body is uniform across interrupting and non-interrupting boundaries, so there is exactly one rule to learn ("the body ends where it ends; rejoin with `goto`") instead of one rule per cancellation mode.
- Good, because wiring a boundary event to the virtual entry makes every escape chain's own internal control flow, including a nested `if`/`else`, restructurable on exactly the same terms as the main flow, rather than falling back to `goto`s for a construct that has nothing irregular about it on its own.
- Good, because a host-derived id survives every reordering the decompiler's trailing-position rule performs, without adding a new re-key rule to the round-trip normalizer for the generation direction.
- Bad, because a node reachable from both the main flow and an escape chain loses a tight immediate dominator, degrading a main-flow `if`/`else` whose join such a chain jumps into into `goto`s on decompile.
  That is accepted as a correct description of a graph shape with two genuine entry points, not worked around.
- Bad, because a host-less `on` handler written inside a hosted handler's body is silently promoted to guard the outer container the hosted handler itself attaches to, rather than being scoped to just that escape path.
  It is a direct, unavoidable consequence of treating a hosted handler as transparent to the flow-container walk, and one an author cannot see from the source alone.
- Bad, because two boundary handlers sharing a host and a trigger but differing only in code cannot be told apart by id text alone before the positional collision suffix is applied, which is stable across a recompile but exposed on an import written by another tool.

### Confirmation

`packages/language/test/parsing.test.ts` pins the colon's disambiguation directly: `on Review: timer after "PT2H"` parses with `host` set to `'Review'`, `trigger` set to `'timer'`, and `particle` set to `'after'`, never confusing the host with the trigger.
`packages/language/test/scoping.test.ts` pins the transparency rule in both directions (`goto` from inside a hosted body reaching the main flow and back), and `packages/transform/test/ast-to-ir.test.ts` pins the promotion consequence: a host-less handler written inside a hosted body lowers into the outer container.
`packages/language/test/validating.test.ts` pins the six-trigger scope, the escalation host restriction, and the compensation-has-no-host refusal, each with an exact-message assertion.
`packages/transform/test/cfg-analysis.test.ts` pins the virtual-entry wiring and the accepted dominance trade-off as an explicit regression case, not an incidental property.
`packages/transform/test/ir-to-dsl.test.ts` pins the self-contained body, including a nested `if`/`else` inside an escape chain restructuring cleanly and a chain that rejoins the main flow printing as `goto`.
`packages/transform/test/synthesize-ids.test.ts` pins the host-derived id template and its collision suffixing.
The frozen `tests/golden/boundary-events.bpmn` fixture and its round-trip suite exercise every one of these decisions together across a real DSL -> XML -> IR -> DSL -> IR cycle, including the import-first direction that is this scheme's one open disambiguation case.

## Pros and Cons of the Options

### The colon separator

- Good, because it resolves the ambiguity at the second token, requiring no lookahead beyond what the parser generator already performs by default.
- Good, because it leaves every trigger word and timer particle a soft identifier, touching none of ADR-0016's design.
- Bad, because it is one more character an author has to remember relative to the originally proposed bare form, for a distinction the bare form cannot actually make.

### Promoting trigger words to keywords, admitted back as identifiers by type

- Good, because a keyword-based host/trigger boundary would need no separator character at all.
- Bad, because it touches roughly two dozen individual grammar productions rather than one, reversing ADR-0016's soft-word design for the sites it touches.
- Bad, because the ambiguity is not actually removed, only resolved by the parser generator's own alternative-ordering rule, reported solely as a build-time warning and invisible to anyone not reading the build log line by line.

### A postfix host clause (`on error "X" at Pack`)

- Good, because it reads left-to-right as "catch this, at this activity," which some authors may find more natural than naming the host first.
- Bad, because `at` already belongs to the timer particle clause (`on timer at "2026-08-01T09:00:00"`), recreating the same word-level collision the colon exists to avoid, in a different position.

### All eight of the language's catchable triggers as boundary events

- Good, because it would need no per-trigger row distinguishing boundary-legal triggers from the rest.
- Bad, because it would let the surface author a `bpmn:BoundaryEvent` carrying a `compensateEventDefinition`, a document Operaton's own parser does not treat as an ordinary boundary attachment and that this language deliberately keeps expressed only as a subprocess undo block (ADR-0018).

### Falling through to the host's successor

- Good, because it needs no `goto` at all for the common "retry, then continue" shape.
- Bad, because it is wrong by default for a non-interrupting boundary: the host's own token is still advancing the main flow, so falling through duplicates it and runs the remainder of the process twice.

### Wrapping a hosted handler's body in its own container

- Good, because it would reuse the host-less handler's existing lowering unmodified, needing no new transparency rule in the scope provider.
- Bad, because BPMN's own boundary-event semantics require the escape path to be a flow element of the same container as the host, not a nested one; wrapping it would make a `goto` back to the main flow cross a container boundary the same way ADR-0016's rule already forbids for a host-less handler, defeating the entire point of allowing a rejoin.

### Leaving a boundary event unwired in the restructuring analysis

- Good, because it needs no change at all to the analysis's entry-wiring rule.
- Bad, because every escape chain becomes permanently un-restructurable: not even a chain with no internal branching of its own gets an immediate dominator, so the restructurer could never recognize anything inside it but a flat sequence of `goto`s.

### A second CFG analysis rooted at each boundary event

- Good, because it would keep the main flow's own dominance relationships completely untouched by the presence of any boundary event.
- Bad, because the restructurer's `Emitter` design holds exactly one analysis per container; a node reachable from both the main flow and an escape chain would have two independent, and potentially disagreeing, dominance answers with no mechanism to reconcile them.

### Reusing the positional `EventSubProcess_<X>` id scheme

- Good, because it would need no new id constructor at all.
- Bad, because a positional coordinate is exactly the property that drifts once the decompiler moves a handler to the end of its container's statement list, the instability `normalizeIr` already has to canonicalize away for host-less handlers, which a host-derived id avoids needing in the first place.

## More Information

Related decisions: ADR-0016 (soft trigger words and the derived event-root design, both of which this decision reuses untouched: the colon separator exists because trigger words stay soft, and a boundary event's `errorRef`/`escalationRef` derivation is the same one ADR-0016 already established).
ADR-0017 (the per-trigger payload surfaces, where message, signal, timer, and conditional payloads render identically whether the handler is hosted or not, since a boundary header reuses the same payload-rendering function a host-less handler's header already uses).
ADR-0018 (compensation through event sub-processes, whose decision this one's exclusion of compensation from the boundary form preserves rather than supersedes, keeping its import-side `isForCompensation` guard valid for the reason stated there).
ADR-0009 (dominator/post-dominator restructuring, the analysis this decision's CFG-entry wiring extends, and the reason a boundary event's dominance trade-off is described as a correct property of the graph rather than a defect in the restructurer).
ADR-0010 (deterministic structural ids, the collision-resolution convention a host-derived boundary id reuses, and the contrast against the positional scheme this decision deliberately does not reuse).
ADR-0013 (the target audience and no-boilerplate rule, the reason a hosted handler reuses the existing `on`/`throw`/`emit` vocabulary rather than introducing a distinct construct for a boundary attachment).
ADR-0014 (the honest import contract, under which a `bpmn:BoundaryEvent` imports every trigger this decision admits, refusing a compensation boundary and any host outside this same container rather than mangling either into an approximation).

Extended by ADR-0028 (work that can be given up), which adds `cancel` to this attachment axis on the one host kind that can catch it, the `attempt` block.
