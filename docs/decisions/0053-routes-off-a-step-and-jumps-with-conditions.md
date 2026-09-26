---
status: accepted
date: 2026-09-15
decision-makers: Marlon Kranz
---

# A step's routes print as the fork the engine runs, and a degraded split keeps its conditions on its jumps

## Context and Problem Statement

A BPMN step may leave on several sequence flows, and the catalog in ADR-0009 printed them as an `if` chain, a choice that takes one of them.
The engine takes more than one.
`BpmnActivityBehavior.performOutgoingBehavior` leaves a step by every flow whose condition holds or that carries none, and by the flow the step names as `default` only when none was taken, so two plain flows are a parallel fork and a conditioned flow beside a plain one is an inclusive fork, the rule `InclusiveGatewayActivityBehavior.execute` applies to a gateway of that kind.
The printer had the exact forms, `parallel { { B } { C } }` and `parallel { if (ok) { B } { C } }`, and wrote `if (true) { B } else { C }` with a report instead.
The import now carries a step's `default` (`defaultFlowId` on every activity kind), which the report used to say it could not see.

Three neighbouring shapes had no report or a poor one.
A fork or race the catalog cannot fold printed every route as an unweighed jump, `if (true) { goto A } else if (true) { goto B }`, so the conditions the routes carried were discarded and the script held no marker for the reader to find.
A parallel, inclusive or event-based gateway with no outgoing flow printed nothing, although the inclusive one throws `stuckExecutionException` in the model and the event-based one waits forever.
A gateway whose route returns to itself matched the loop patterns with the exit route as the body, so `while (go) { user A }` came out of a model that loops on the gateway until `go` holds and runs `A` once.
A jump written into a branch of an `await` or `parallel` block from outside it is refused by the validator and nothing in the print said so.
A guard clause whose branch opens on a second split dropped the edge into that split with a marker, because the branch walk admitted only terminals as guard-clause entries and a jump cannot name a gateway.

## Decision Drivers

- The totality guarantee in ADR-0009: every route keeps a form, and a jump is the fallback for what the catalog cannot fold, never the first answer for a shape it can.
- A report describes what runs differently and nothing else; a print that runs the same as the model draws none.
- What the marker and the warnings channel say has to be enough to start hand-repair, so a lost split names itself in the source.

## Considered Options

- Print a step's routes through the fork block with the step as the split, and keep the conditions on the jumps of a degraded split
- Keep the `if` chain for a step's routes and the unweighed jumps, and sharpen the reports
- Refuse a step with several routes on import

## Decision Outcome

Chosen option: print a step's routes through the fork block with the step as the split, and keep the conditions on the jumps of a degraded split, because both are exact forms the printer already had, and the engine's rule for a step is the inclusive fork's rule.

`followLinear` reads the step's routes off the model.
Two or more hand the step to the fork printer as its split: inclusive when any route carries a condition or the step names a `default`, parallel otherwise, with the `default` as the block's `else`.
The one shape a choice routes the same way, exactly one weighed route beside the `default`, keeps the `if`/`else` the choice prints, which reads better and lowers to the same routing.
The fork printer is keyed on a split's id and kind rather than on a gateway, so a step's block takes the merge's `join` settings and no head settings of its own.
A step whose fallback carries a condition is reported the way an inclusive fork's is: the engine skips the fallback while weighing and takes it when nothing held, so the condition is weighed nowhere and the run is the same without it.
A step whose every route is weighed and which names no fallback draws the invented-fallback report a split of that shape draws.

A fork or race the catalog cannot fold prints one marker line naming the split and its kind, `split G degraded to jumps; was inclusive`, and then the `if` chain of jumps with each route's condition on its own jump and the split's fallback as the `else`.
The report says the conditions are on the jumps and that the split's kind, whether it opened one branch, every branch whose condition held, or the first to resolve, is written nowhere.
An exclusive split with no clean join prints its jumps as it did, with no marker: an `if` chain of jumps is a choice, so nothing of it is lost.

A gateway with no route out prints nothing and is reported by kind: a parallel gateway ends the run as the script's block end does (`ParallelGatewayActivityBehavior.execute` leaves by no route and `PvmExecutionImpl.leaveActivityViaTransitions` ends the execution); an inclusive gateway stops the model with an error (`InclusiveGatewayActivityBehavior.execute` throws `stuckExecutionException`); an event-based gateway holds the model forever (`EventBasedGatewayActivityBehavior.execute` is a wait state with nothing to wait for); an exclusive gateway keeps the model from deploying (`BpmnParse.validateExclusiveGateway`), which the import refuses ahead of the printer, so the print report covers hand-built IR alone.

The loop patterns ignore a back edge whose source is its target.
The gateway then prints as a choice whose route back into itself has no name, so it takes the dropped-edge marker and its report, and the exit route keeps its condition.

The branch walk records the `await` or `parallel` branch each statement is printed in, as the path of branch ids from the outermost block down, and every jump records the path it was printed under.
Once the walk is done, a jump whose target sits in a branch the jump's path does not begin with draws a report under `refusedStatement`: the validator refuses a `goto` into a branch from outside it, since a branch's steps run only when the whole block is reached.
The jump is written all the same; the model is where the route comes from.

A guard clause admits a gateway the split dominates as its branch entry.
A jump could not name it anyway, and the branch walk sorts the gateway's routes with the guard's continuation as their stop node, so a split whose every route is weighed inside a guarded branch continues at that node the way ADR-0052 describes, and a loop that opens a guarded branch prints as the loop it is.

An event sub-process a flow edge leads into is malformed IR and the printer throws, as it does on a duplicate id; the import refuses the flow ahead of it.

### Consequences

- Good, because a step with two plain routes or with a weighed route beside a plain one round-trips to the routing the engine runs, with no report.
- Good, because the conditions of a degraded split survive on its jumps, and the marker line puts the reader at the split rather than leaving the jumps to explain themselves.
- Good, because the fork printer, the invented-fallback report and the fallback-condition report each have one home, and a gateway and a step share it.
- Neutral, because a step whose routes reconverge at a merge of another kind, or at a step, degrades to jumps under the marker: the block form synchronizes at a merge of its own kind, which the model does not have there.
- Bad, because a branch that ends inside a loop body, a `do { end } while`, and a loop gateway the compiler leaves without an incoming flow still print as jumps, and a post-test loop whose body ends inside a branch prints the jump into that branch the validator refuses; these are reported and pinned as they are.

### Confirmation

The table in `packages/transform/test/ir-to-dsl.test.ts` under "a step whose own routes split" pins the printed source, the whole warning list, the re-parse and the real-node reachability for two plain routes, two plain routes into an implicit merge, a weighed route beside a plain one, one weighed route beside the fallback, a weighed route beside a plain one and the fallback, and two weighed routes with no fallback.
Beside it, one row pins the marker line and the weighed jumps of an inclusive fork whose merge a boundary chain also enters, one row per gateway kind pins the empty-split report, two rows pin the self-looping gateway, two the jump across a branch border, and one the guard clause opening on a split.
`tests/goto-fallback.round-trip.test.ts` runs the composite shapes a fuzz run drew through compile, export, import and print, and pins each print's warning categories and whether it validates.

## Pros and Cons of the Options

### Print a step's routes through the fork block with the step as the split, and keep the conditions on the jumps of a degraded split

- Good, because the fork block already prints both kinds and both fallback reports, so the step gains them by naming itself as the split.
- Good, because a jump chain that weighs its routes is the same chain the choice prints, so the degraded print gains no new form.
- Bad, because a step whose routes merge at a merge of another kind now prints jumps under a marker where it printed a readable `if` chain, which was a choice the model is not.

### Keep the `if` chain for a step's routes and the unweighed jumps, and sharpen the reports

- Good, because nothing in the print changes.
- Bad, because the print of a common Modeler shape, a task with two plain flows, runs one route where the model runs both, and the exact form was one line away.

### Refuse a step with several routes on import

- Good, because the printer never sees the shape.
- Bad, because the engine deploys and runs it, and the import contract in ADR-0014 refuses only what the engine refuses or what changes a stored value.

## More Information

The step's routing is `followLinear` in `packages/transform/src/ir-to-dsl.ts`; the fork block is `emitFork`, the jumps `emitJumps`, the empty-split report `emptySplitWarning`, the branch bookkeeping `emitBranch` and the check at the end of `Emitter.emit`, and the guard-clause entry `branchStaysInRegion`.

Amends ADR-0009, whose catalog entry for a statement with more than one route out becomes the fork block, and whose degraded split keeps its conditions on the jumps under a marker line.
Amends ADR-0014, whose step-`default` bullet this rule closes by printing the step's routes as the fork block with the `default` as its `else`, and whose print-hop reports gain a degraded split's marker line, an empty gateway, a self-loop, and a jump across a branch border.

Related decisions: ADR-0009 (the catalog this rule extends).
ADR-0014 (the import contract, whose `default`-on-a-step clause this rule closes).
ADR-0045 (the fallback the compiler reserves on a fork, which the printed block of a step's routes reads back through).
ADR-0052 (the enclosing continuation, which a split inside a guarded branch now reaches).
