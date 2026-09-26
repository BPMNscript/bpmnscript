---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Reserve an inclusive fallback only where the engine can take it

## Context and Problem Statement

`lowerParallel` reserved a default flow on every inclusive fork and, with no `else` written, ran it straight to the join.
`InclusiveGatewayActivityBehavior.execute` takes every non-default flow that has no condition or a true one, and adds the default only when that set comes out empty.
A branch with no head is in the set every time, so beside one the fallback can never be taken.
The printer leaves a fallback that runs straight into the merge out, so the compiled document came back without it, and once the split degraded to jumps the fallback printed as an `else`, which the validator refuses beside an unheaded branch.
The same lowering had a second gap.
`lowerWhile` wired its back-edge without the exit id the body reserved, so a `while` whose body ended in a loop left the inner gateway declaring a default flow no flow carried, and `irToXml` refused the document.
Which forks should name a fallback, and how does a reserved exit reach the back-edge?

## Decision Drivers

- The compiler should write no flow the engine can never take.
- The tool's own output should print back as source the validator accepts.
- A valid program must compile.

## Considered Options

- Reserve the fallback only beside an `else` or when every branch is conditioned, and carry the reserved exit id on every fall-through, the back-edge included
- Keep reserving the fallback on every inclusive fork and teach the printer to drop the `else` it prints for a dead one
- Elide a join that exactly one flow reaches and that carries no setting, retargeting the flow to the join's successor

## Decision Outcome

Chosen option: reserve the fallback only beside an `else` or when every branch is conditioned, and carry the reserved exit id on every fall-through, because it removes the dead flow where it is written and the crash with one argument.

`lowerParallel` reserves `Flow_<fork>_default` when the fork is inclusive and either an `else` branch is written or every branch carries a condition.
With an `else` the default points at that branch.
With every branch conditioned it runs straight to the join, since such a fork with no default deploys and then throws a stuck execution the first time no condition holds.
Beside an unheaded branch no default is written and the fork carries no `default` attribute.
The validator's refusal of an `else` beside an unheaded branch stands, for the same reason: the branch it would fall back from always runs.
`lowerWhile` adds its back-edge with `body.exitFlowId`, as `lowerDoWhile` already did, so a body ending in a loop keeps that loop's declared default on the flow the enclosing head takes.

A join that exactly one flow reaches stays written.
`ExclusiveGatewayActivityBehavior.doLeave` and the parallel and inclusive behaviours run it as a pass-through, and `BpmnParse.validateExclusiveGateway` accepts its single unconditioned outgoing flow.
The printer recovers a fork whose branch terminates, and a guard clause at the tail of a loop body, from that merge: without it, `parallel { { user A } { end X } } user C` degrades to jumps and `while (x) { if (c) { end R } }` prints as `while (x) { end R }`.
The third option waits until the printer structures those shapes without the merge.

### Consequences

- Good, because a compiled inclusive fork beside an unheaded branch prints back without a warning and re-parses without an error.
- Good, because a `while` whose body ends in a loop compiles.
- Bad, because a join that exactly one flow reaches stays in the document, where bpmnlint reports it as superfluous and the auto-layout draws the default edge into it across the terminating branch's end event.

### Confirmation

`packages/transform/test/ast-to-ir.test.ts` pins the four fallback shapes in one table over `parallel { if (a > 1) { ... } ... }`, and the nested `while` with the reserved id on its back-edge through `irToXml`.
`packages/transform/test/ir-to-dsl.test.ts` pins that a modeled fallback running straight into the merge comes back as the model without that edge.
The frozen pairs `tests/golden/branch-and-race.{bpmnscript,bpmn}` and `tests/golden/gateway-settings.{bpmnscript,bpmn}` each hold an inclusive fork beside an unheaded branch with no `default` attribute.

## More Information

Amends ADR-0025, whose rule that the default flow is always emitted no longer holds; the `else` refusal it records stands.
Operaton behaviour was read from `InclusiveGatewayActivityBehavior.execute`, `ExclusiveGatewayActivityBehavior.doLeave` and `BpmnParse.validateExclusiveGateway`.

Related decisions: ADR-0009 (dominator-based restructuring, which is what needs the merge), ADR-0024 (a terminating branch does not rejoin).
