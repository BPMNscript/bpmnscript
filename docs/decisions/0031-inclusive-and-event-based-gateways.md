---
status: accepted
date: 2026-10-17
decision-makers: Marlon Kranz
---

# Inclusive and event-based gateways

## Context and Problem Statement

Every BPMN element the language has taken on so far had a construct to hang off.
`bpmn:inclusiveGateway` and `bpmn:eventBasedGateway` have nothing to attach to, because under ADR-0011 no author ever writes a gateway.
The desugarer synthesizes every gateway from block structure, and the decompiler elides every one it matches.
That elision is what makes the round trip idempotent, and the grammar states the premise in its own header (`packages/language/src/bpmn-script.langium`).

So the question is not which keyword spells "inclusive gateway".
It is whether block structure can express the intent well enough that the compiler still picks the element, and which of the flows out of such a fork are worth writing.
A gateway's `name` survives XML to IR to XML, then dies at the print hop, where no gateway has a statement form to carry it (`normalizeContainer`, `tests/helpers/normalize-ir.ts`).

A split can also stop the run on purpose.
`ExclusiveGatewayActivityBehavior.doLeave` and `InclusiveGatewayActivityBehavior.execute` throw `ENGINE-02004 No outgoing sequence flow for the element with id '...' could be selected for continuing the process` when no flow is taken and none is the default, and a step whose routes are all conditioned throws `ENGINE-02006` (`BpmnActivityBehavior.handleNoTransitions`).
A variant of the Operaton invoice example whose approval split names no default is one such model, and a script needs a way to say it.

## Decision Drivers

- ADR-0006 binds two rules: a keyword names what the user means rather than the BPMN element, and the compiler must not require what it can infer.
- Gateway elision is what ADR-0014's decompiler relies on for idempotence.
  A gateway with textual identity gains an authored id and stops round-tripping under ADR-0010's positional scheme.
- Operaton does not police the two kinds equally: an inclusive gateway gets no structural validation, an event-based gateway a list of them.
- The compiler should write no flow the engine can never take, and a valid program must compile.
- The tool's own output should print back as source the validator accepts.
- Trigger words are soft identifiers by design (ADR-0023), so a rule proves nothing until a live parser accepts it.
- A label dropped on the way out needs a channel to be reported through, and ADR-0012's contract covers `xmlToIr` only.
- The engine's no-match failure is not a BPMN error: no error boundary or `on error` handler catches it.
- A new reserved word costs authors a name, and a variable has no backtick form to win it back.

## Considered Options

- For the inclusive split, conditioned `parallel` branches headed by `if` and `else`, which add no keyword, no statement, and no id template, at the cost of an element choice invisible in the block's keyword.
- For the inclusive split, branches headed by a bare parenthesized condition, which parses as cleanly, but a parenthesized expression opening a line is a shape this language has nowhere else.
- For the inclusive split, a separate construct with its own reserved keyword, which would make the element visible, but it spends a word and names the BPMN element rather than what the user means.
- For the fallback flow, reserve one only beside an `else` or when every branch is conditioned, which writes no flow the engine can never take, at the cost of a fork whose flows out differ by branch shape.
- For the fallback flow, reserve one on every inclusive fork and teach the printer to drop the `else` it prints for a flow that can never be taken, which keeps the lowering uniform, but writes a dead flow the printer then has to hide, and the `else` it prints for one is source the validator refuses.
- For the fallback flow, a written `else` required whenever every other branch is conditioned, which would make the fallback visible, but it is required syntax for something the compiler can infer.
- For the race, a multi-branch `await`, which reserves no word and generalizes a meaning the keyword already carries.
- For the race, a distinct keyword such as `race`, which could not be confused with anything, but it costs the language a name authors may want.
- For the race's join, a synthesized exclusive join the block falls through, which reuses `if`'s join and cannot duplicate a token, at the cost of a join that sees one.
- For the race's join, self-contained branches that rejoin by `goto`, which would match a hosted `on` handler, but would force a `goto` for the common timeout case.
- For a join that exactly one flow reaches, keep it written, which is what lets the printer structure a terminating branch and a guard clause; eliding it and retargeting the flow to the join's successor would satisfy bpmnlint and lose both.
- For the gateway label, no slot, with the print-side drop reported through a warnings channel out of `irToDsl`, which keeps every gateway elided and puts the label on the same channel as the print hop's other reports, at the cost of a signature change.
- For the gateway label, a slot on `if`, `while`, `parallel`, and the two new forms, which is the only way a label survives a full BPMN to DSL to BPMN round trip, but a labeled gateway is an authored gateway.
- For the gateway label, no slot and a silent drop, which costs nothing, and is the one thing ADR-0012's contract exists to prevent.
- For a split that fails when no condition holds, a closing `else fail` on an `if` chain and on a `parallel` block, with `fail` a soft word legal only after `else`.
- The same form with `fail` a reserved word, which the TextMate grammar would colour for free, but it would take `var fail` and `user fail` out of the language.
- `else throw`, which reads as an error, but `throw` already raises a BPMN error that a handler can catch, and this failure cannot be caught.
- No form for that split, and a warning on import, which leaves every such import changing what runs.
- A `gateway` keyword, or a flat node-and-edge escape hatch, which would express every gateway shape, but a gateway that prints re-parses with an authored id.

## Decision Outcome

Both gateways stay fully synthesized and fully elided.
Nothing in the surface names a gateway, and ADR-0010's positional ids keep working unchanged.
Every form below parsed with zero ambiguity warnings in a live Langium parser with Chevrotain self-analysis on.

A branch of a `parallel` block may be headed by `if (condition)`, by `else`, or by nothing at all, and the compiler picks the element from what the branches carry rather than from the keyword.
Operaton takes every non-default flow that has no condition or a true one, and adds the default only when that set comes out empty (`InclusiveGatewayActivityBehavior.execute`), so `lowerParallel` reserves `Flow_<fork>_default` only where the engine can take it: beside an `else`, or, when every branch carries a condition and the block does not close with `else fail`, running straight to the join, the rule `lowerIf` applies at the same position.
Beside a branch carrying no condition that branch is in the taken set every time, so the set never comes out empty, a fallback behind it could never run, and an `else` written there is refused for the same reason.
All of this is a lowering rule rather than a validator rule because `BpmnParse.parseInclusiveGateway` validates nothing.

A split that stops the run when no condition holds closes with `else fail`, and `fail` is a soft word legal only there, so it stays a legal variable and step name.
`lowerIf` reserves no default flow for it and `lowerParallel` adds no fallback to the join, so the compiled split carries only its conditioned flows and the engine stops the run exactly as the imported model did.
The printer writes `else fail` for every exclusive or inclusive split, gateway or step, whose model routes are all conditioned and that names no default, except a fork that degrades to jumps, whose chain of jumps closes without it.
An `if` chain is conditioned on every branch by its shape, so `else fail` is always legal there.
On a `parallel` block the validator refuses it with no conditioned branch, beside an unconditioned branch, which always runs, and beside an `else` branch, which runs whenever no condition holds, the same reasons it refuses an `else` in those places.
A loop takes no `else fail`, because the route out of a `while` or `do ... while` is its fallback, and the remaining exits of a loop head print as an `if` chain that takes `else fail` like any other.
Beside `else fail` an empty conditioned branch is how a case carries on rather than failing, so it draws no empty-branch warning.

Every fall-through carries the reserved exit id, the back-edge included.
`lowerWhile` wires its back-edge with `body.exitFlowId`, as `lowerDoWhile` does, so a `while` whose body ends in a loop keeps that loop's declared default on the flow the enclosing head takes and `irToXml` accepts the document.

A join that exactly one flow reaches stays written.
`ExclusiveGatewayActivityBehavior.doLeave` and the parallel and inclusive behaviours run it as a pass-through, and `BpmnParse.validateExclusiveGateway` accepts its single unconditioned outgoing flow.
The printer recovers a fork whose branch terminates, and a guard clause at the tail of a loop body, from that merge: without it, `parallel { { user A } { end X } } user C` degrades to jumps and `while (x) { if (c) { end R } }` prints as `while (x) { end R }`.
Eliding such a join waits until the printer structures those shapes without it.

The race is a multi-branch `await`, because `await` already means the token stops here until this resolves and a race is that meaning over a set.
Reusing the word costs nothing, because `await {` cannot parse otherwise: the `IntermediateCatchEvent` shape takes a trigger word after the keyword.
Its triggers are the four `await` already takes, which is also everything Operaton accepts in this position (`BpmnParse.parseIntermediateCatchEvent`), and its branches fall through to a synthesized exclusive join, reusing `if`'s join and its pruning when every branch terminates (`pruneUnreachableJoin`).
Operaton gives every catch event behind an event-based gateway the start behavior `CANCEL_EVENT_SCOPE`, so exactly one branch of a race ever runs.

An inclusive pair reuses `Gateway_<X>_fork` and `Gateway_<X>_join` unchanged, since exactly one `parallel` statement sits at any structural coordinate.
The race adds one template, `Gateway_<X>_race`, whose segment word joins the reserved-name pattern.

Neither `if`, `while`, `parallel`, nor either new form gains a label slot, and the reason is structural.
One construct lowers to two gateways, so a single slot carries at most half of what an imported document may hold.
Instead `irToDsl` returns a result carrying source and warnings rather than a bare `string`, as ADR-0012 did to `xmlToIr`, since a channel a caller can skip is a silent drop.

This extends the structured surface rather than breaching it.
Every gateway is still derived from block structure, none is written, and none is named, so the grammar header's claim holds word for word.

Both kinds import rather than being refused (`mapContainerChildren`, `packages/transform/src/xml-to-ir.ts`).
An inclusive gateway reads `name`, `default` and its job settings (ADR-0021), and carries under the one refusal every gateway kind shares: an `operaton:inputOutput` on a gateway is refused, quoting `BpmnParse.checkActivityInputOutputSupported`, which fails the deployment.
Beyond that it has no refusal of its own.
An event-based gateway carries, refusing three shapes, each following a refusal in Operaton's own parser: an outgoing flow whose target is not a `bpmn:intermediateCatchEvent` (`BpmnParse.parseEventBasedGateway`), a downstream catch carrying a link definition (`BpmnParse.parseIntermediateCatchEvent`), which the rule that no sequence flow may enter a link catch already refuses for every flow and so for a branch of a race as well, and a downstream catch reached by more than one path (`BpmnParse.parseSequenceFlow`), counted over every path in.
The last is wider than the engine's rule: Operaton lets a path through where it leaves an event-based gateway, so it takes a catch reached only by such paths, and this refuses that too.
Neither that shape nor the one Operaton refuses is authorable, so the extra width costs no script anything.
`parseEventBasedGateway` rejects `operaton:asyncAfter` on the gateway itself as well, so the validator refuses it on a multi-branch `await` head under the same rule, and the import refuses a document carrying it rather than dropping it.

### Consequences

- Good, because both gateways stay synthesized and elided, so idempotence, the id scheme, and the control-flow analysis need no new rule and no new IR flag.
- Good, because neither construct spends a reserved word; reserving `race` would take `var race: string` and `user race` out of the language.
- Good, because a compiled inclusive fork beside an unconditioned branch prints back without a warning and re-parses without an error.
- Good, because a `while` whose body ends in a loop compiles.
- Good, because an imported split whose routes are all conditioned and that names no default rebuilds unchanged, the invoice variant included.
- Bad, because a conditioned `parallel` reads as one construct but compiles to either of two BPMN elements, so a BPMN-literate reader must read every branch.
- Bad, because `irToDsl` changes its return shape, touching every call site, and the drop that motivated it costs the reader a gateway's name rather than anything the process does.
- Bad, because the label comes back on a BPMN-to-BPMN pass but never on a BPMN-to-DSL one, so a decompiled and recompiled document loses every gateway label.
- Bad, because a conditional branch of a race can win without waiting (`EventBasedGatewayActivityBehavior.execute`), which no part of the surface shows.
- Bad, because an inclusive fork closed on an exclusive merge, the common hand-drawn shape, degrades to `goto`s a reader repairs by hand.
- Bad, because an imported split whose routes do not meet again prints its continuing route as an empty `else if` branch rather than as a fall-through.
- Bad, because the soft word `fail` needs its own highlighting rule in the TextMate grammar and a test that pins it to the vocabulary.
- Bad, because a join that exactly one flow reaches stays in the document, where bpmnlint reports it as superfluous and the auto-layout draws the default edge into it across the terminating branch's end event.

### Confirmation

`packages/language/test/` pins a `parallel` block mixing an `if` branch, a plain branch and an `else` branch, `await { ... }` parsing as a race while `await timer("PT1H")` still parses as a single catch, and each validation rule on the two heads.
`packages/transform/test/` pins element selection, the four fallback shapes in one table, the nested `while` with the reserved id on its back-edge through `irToXml`, the race's join and its pruning, the inclusive carry, each refusal by name, elision of both new pairs, the dropped-label warning reaching the caller, and a modeled fallback running straight into the merge coming back as the model without that edge.
The frozen pairs `tests/golden/branch-and-race.{bpmnscript,bpmn}` and `tests/golden/gateway-settings.{bpmnscript,bpmn}` each hold an inclusive fork beside an unconditioned branch with no `default` attribute, asserting IR idempotence after normalization and that the decompiled source recompiles cleanly, and a Docker-gated end-to-end test shows the losing race branch canceled and the inclusive join waiting for exactly the branches taken.

`packages/language/test/` also pins both `else fail` heads, each of its validator rules, its completion after `else` and the highlighting of `fail`.
`tests/else-fail.round-trip.test.ts` pins that an imported exclusive and inclusive split with no default prints as `else fail` and compares with no differences and no warning, and `tests/e2e/claim-routing.test.ts` runs `examples/spring-boot/processes/claim-routing.bpmnscript` on Operaton, where a holding condition runs its route and with none holding both the start request and the task completion before the inclusive fork fail with `ENGINE-02004`.

## More Information

Operaton behavior was read from `BpmnParse.java`, `InclusiveGatewayActivityBehavior.java`, `ExclusiveGatewayActivityBehavior.java` and `EventBasedGatewayActivityBehavior.java` in the `operaton/operaton` repository.
The documented restrictions are from <https://docs.operaton.org/docs/documentation/reference/bpmn20/gateways/event-based-gateway/>.
The dataset behind Compagnucci, Corradini, Fornari and Re (BISE 66(1), 2024, DOI 10.1007/s12599-023-00818-7) has an event-based gateway in roughly 12 percent of its 38,863 models and an inclusive gateway in roughly 6 percent.
