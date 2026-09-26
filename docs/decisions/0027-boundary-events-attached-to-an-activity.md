---
status: accepted
date: 2026-07-23
decision-makers: Marlon Kranz
---

# Boundary events attached to an activity

## Context and Problem Statement

A host-less `on` handler compiles to an event sub-process that guards its whole enclosing process or subprocess body, as the decision outcome below records.
BPMN has a second, narrower attachment for the same catch vocabulary: a `bpmn:boundaryEvent` docked directly on one activity, which only catches while that activity is running and, depending on `cancelActivity`, either cancels it the moment the trigger fires or lets it keep running alongside the catch.
Giving `on` an optional host turns it into this second attachment form without introducing a competing keyword or a second handler construct.
Four questions settle together: how a host is spelled without colliding with the handler shape `on timer("PT2H")` that already parses; which of the language's catchable triggers may attach; what a hosted body compiles to, given that the host-less form's meaning must not move; and how a token that appears directly at a boundary event, without ever traversing the main flow, is represented in the dominator-based restructuring analysis (ADR-0014).

## Decision Drivers

- Every trigger word is a soft identifier (ADR-0023), so a new syntax slot cannot recover disambiguation from the trigger word's token type, only from structure the grammar contributes at parse time.
- The host-less handler's meaning is exercised by existing golden fixtures: a hosted handler is a new attachment form layered next to it, not a replacement.
- Operaton's own parser (`BpmnParse.parseBoundaryEvents`) is the authority on which triggers, and which host shapes, a boundary event may legally carry; a surface stricter than the engine owes a reason.
- The restructuring analysis (ADR-0014) is total over every valid IR, and a boundary event is the IR's first flow-element shape with outgoing edges but no incoming ones.
- The honest import contract (ADR-0012) forbids silent mangling on import, and compensation stays a subprocess undo block (ADR-0028) rather than gaining a second attachment mechanism.

## Considered Options

- A colon separator, `on Pack: error(X)`, which resolves the reading at the second token, well inside the two-token lookahead Langium's default parser handles without any grammar annotation.
- A bare space, `on Pack error(X)`, which is ambiguous with a handler that parses today, since a host-less handler carrying a code and a hosted handler carrying none both read as `on` followed by two identifiers, and the ambiguity sits in the token text rather than the token type, so no lookahead over token types can tell the two apart.
- A postfix clause, `on error(X) at Pack`, which reads left-to-right as "catch this, at this activity" but reuses the word `at` that a timer's date key already claims, recreating the same collision in a different position.
- Promoting the trigger words to real keywords and re-admitting them as identifiers through a data-type escape hatch, which touches roughly two dozen grammar productions rather than one and still leaves a residual ambiguous alternative between the keyword-led host form and the timer form, resolved by the generator's own alternative ordering and reported only as a warning on the build's stderr.
- A trigger scope read from the engine's own boundary parsing, so every boundary event the surface admits is one the engine deploys.
- Every catchable trigger the language has, which needs no per-trigger row but would let the surface author a `bpmn:BoundaryEvent` carrying a `compensateEventDefinition`.
- A self-contained body, wrapping nothing and rejoining only by an explicit `goto`, which matches what a bare `{ }` block already means everywhere else: a scope ends where its last statement ends, unless something inside it names where control goes next.
- Falling through to whatever statement follows the host, which needs no `goto` for a "retry, then continue" shape on an interrupting boundary but duplicates a non-interrupting host's still-running token and runs the rest of the process twice.
- Wrapping the body in a container of its own, as a host-less handler already is, which BPMN's boundary-event semantics rule out: the escape path has to be a flow element of the host's own container, so a `goto` back to the main flow would cross a container boundary.
- Wiring a boundary event to the analysis's virtual entry like a start event, against leaving it unwired, which makes every escape chain permanently un-restructurable regardless of how simple its own control flow is.
- A second analysis rooted at each boundary event, which would leave the main flow's dominance relationships untouched but is not supported by the restructurer's single-`Emitter`-per-container design, since two independent analyses over one node and edge set would have no way to agree on which of them owns a node reachable from both.
- A host-derived id, against reusing the positional `EventSubProcess_<X>` scheme, which would drift the moment the decompiler reordered handlers to the end of a container's statement list.

## Decision Outcome

Chosen options: the colon separator, a scope read from the engine, a self-contained body, virtual-entry wiring, and host-derived ids.

The host-less form keeps its meaning.
A host-less `on` compiles to a `bpmn:subProcess` with `triggeredByEvent="true"` in the container whose body holds the handler, the process, a `subprocess` or an `attempt` block, and so catches while any part of that container runs.
Its trigger sits on the start event the event sub-process opens with, `alongside` writes that start as `isInterrupting="false"`, and the handler's body lowers as the event sub-process's own body, with its own implicit start and end.
Its id is the positional `EventSubProcess_<X>` (ADR-0010), and the decompiler prints every event sub-process back as a host-less handler after the container's other statements, in model order, since the compiler numbers each one by its statement index.
`on compensation` is the host-less handler with a record of its own (ADR-0028), and `cancel` has no host-less form (ADR-0029).

The scope is message, timer, signal, conditional, error, and escalation.
Escalation is restricted to a subprocess, an `attempt` block, a call, or a user task because Operaton gates that boundary on `attachedActivity.isSubProcessScope()`, and `parseTransaction` sets that flag exactly as `parseSubProcess` does, so an `attempt` block hosts an escalation on the same terms an ordinary block does.
Error reuses the same `alongside: false` restriction already enforced for a host-less error handler rather than adding a boundary-specific rule.
Compensation is excluded on the grounds ADR-0028 established for it generally: BPMN attaches compensation through a `bpmn:association` and an `isForCompensation` activity, a different attachment mechanism entirely, which also keeps the import-side `refuseIfForCompensation` guard honest inside the boundary event's own import path.
Cancel is excluded here because Operaton allows a cancel boundary on a transaction alone, and ADR-0029 surfaces that container as the `attempt` block and admits one there.

Because a hosted handler's body is not its own container, the scope provider's flow-container walk, the same walk that decides what `goto` may resolve against, treats a hosted `on` as transparent: resolving a name from inside such a body walks straight past the handler to the real enclosing process or subprocess.
That is what makes `goto` legal in both directions across a hosted handler's body, since both a `goto` inside the body reaching the main flow and a main-flow `goto` reaching into the body resolve against the one container the lowering actually places their statements in.

The restructuring analysis wires every boundary event to its container's virtual entry, unconditionally, the same way it already wires every start event.
This is the honest model: at runtime a token genuinely appears at a boundary event the moment its trigger fires while its host is running, without ever traversing a sequence flow into it.
Without this wiring, an escape chain has no immediate dominator at all, and the restructurer can recognize an `if`, a `while`, or a clean join only relative to a dominance relationship, so the chain could never print as anything but unstructured `goto`s.
The accepted trade-off is that a node reachable from both the main flow and an escape chain loses a tight immediate dominator, since neither the main flow's split nor the escape chain alone reaches it unconditionally, so an `if`/`else` whose join such a chain jumps into degrades to plain `goto`s on decompile.
The dominance result is correct: a region two independent entry points can both reach is genuinely not dominated by either one's split.

A boundary event's id is `Boundary_<hostId>_<trigger>`, collision-resolved against the same document-wide `taken` set the implicit start and end ids already share.
The one case this scheme does not fully disambiguate is two boundary handlers sharing a host and a trigger but differing in code: `on Pack: error(A)` and `on Pack: error(B)` are legal, non-duplicate handlers under the validator's `(host, trigger, code)` key, yet both base to the identical `Boundary_Pack_error`, so which one receives the `_2` suffix is positional.
That is stable in the generation direction, since lowering assigns suffixes in statement order.
The decompiler reprints such a group in the rank each handler's own id already carries, the id equal to the base first and `_2`, `_3` and so on after it, so a reimport that lists the group in a different order still keeps each handler under its own id.
Two ids that both fall outside the minted pattern carry no such rank, so nothing but model order settles which prints first, the same exposure to another tool's ordering choice on a first import.
Folding the code into the base id was rejected: no other id constructor sanitizes arbitrary author-supplied text into an id fragment, and a numeric suffix would still be needed for two `timer` boundaries on one host, which carry no engine subscription key and so are never rejected as duplicates.
The round-trip normalizer compensates on the comparison side instead, keying a boundary event's signature on the event definition's own payload rather than on the printed id, so two IR snapshots compare equal regardless of which physical id each assigns to which occurrence.

### Consequences

- Good, because the colon resolves the host/trigger ambiguity with no reserved word, no residual parser-generator warning, and no change to ADR-0023's soft-trigger-word design.
- Good, because the trigger scope admits only what Operaton's own parser accepts, so a boundary event the validator passes carries a trigger the engine deploys.
  The converse does not hold: a compensation boundary is refused on attachment-mechanism grounds rather than on an engine refusal, and Operaton would deploy the document that refusal rejects.
- Good, because excluding compensation costs nothing new to build: the existing `on compensation` undo block already covers the granularity a boundary compensation event would have reached, and the import-side refusal needed only a new call site for the existing guard.
- Good, because the self-contained body is uniform across interrupting and non-interrupting boundaries, so there is one rule to learn instead of one rule per cancellation mode.
- Good, because wiring a boundary event to the virtual entry makes an escape chain's own control flow, including a nested `if`/`else`, restructurable on the same terms as the main flow.
- Good, because a host-derived id survives every reordering the decompiler's trailing-position rule performs, without adding a re-key rule for the generation direction.
- Bad, because a node reachable from both the main flow and an escape chain loses a tight immediate dominator, degrading a main-flow `if`/`else` whose join such a chain jumps into into `goto`s on decompile.
- Bad, because a host-less `on` handler written inside a hosted handler's body lowers into the outer container and therefore guards that whole container rather than just the escape path it is written inside, which follows necessarily from transparency and which an author cannot see from the source alone.
- Bad, because two boundary handlers sharing a host and a trigger but differing only in code cannot be told apart by id text until one carries a minted rank.
  Two such handlers that both import under an id outside the minted pattern still fall back to model order, exposed to whatever order another tool presents them in on a first import.

### Confirmation

`packages/language/test/` pins the colon's disambiguation, the transparency rule in both directions, and the trigger scope, the escalation host restriction, and the compensation-has-no-host refusal, each with an exact-message assertion.
`packages/transform/test/` pins the promotion consequence of transparency, the virtual-entry wiring and the accepted dominance trade-off as an explicit regression case, the self-contained body including a nested `if`/`else` inside an escape chain restructuring cleanly, and the host-derived id template with its collision suffixing.
`tests/fuzz-regressions.test.ts` pins the mint-rank print order for two boundary handlers sharing a host and trigger, both when one side already carries a minted id and when both are authored and fall back to model order.
The frozen `tests/golden/boundary-events.bpmn` fixture and its round-trip suite exercise these decisions together across a real DSL -> XML -> IR -> DSL -> IR cycle, including the import-first direction that is this scheme's one open disambiguation case.

## More Information

Related decisions: ADR-0014 (dominator and post-dominator restructuring, the analysis this decision's entry wiring extends).
ADR-0029 (the `attempt` block, which adds `cancel` to this attachment axis on the one host kind that can catch it).
