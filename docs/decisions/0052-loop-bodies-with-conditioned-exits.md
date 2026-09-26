---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# A split inside a loop body continues at the loop head when a route stays inside

## Context and Problem Statement

The catalog in ADR-0009 folds an exclusive split into an `if` chain when it has a clean join, a post-dominator the split dominates, and into a guard clause when exactly one route is unconditioned, that route being the continuation.
A split inside a loop body has neither when every route carries a condition.
A route that leaves the loop puts the split's immediate post-dominator outside it, at the graph's exit, or at a node behind the loop when the leaving route and the loop exit share an end, so there is no clean join, and with no unconditioned route there is no guard clause.
Every route then printed as a jump.
The approve-review loop of the Operaton invoice example is this shape: `approveInvoice` splits under `${approved}` to the bank transfer, which leaves the loop, and under `${!approved}` to `reviewInvoice`, which runs into the "review successful" gateway that routes back under `${clarified}`.
The printer recognized the `do ... while (clarified)` head, printed both routes as `goto`, hoisted `reviewInvoice` out of the loop after the process's end, and had no name for its edge into the folded loop gateway, so the edge was dropped with a marker.
`ExclusiveGatewayActivityBehavior.doLeave` takes the first route whose condition holds, so the model is a live loop and the rebuilt process ended after the review.
The same shape with a default flow in place of `${!approved}` printed correctly through the guard clause, which was the asymmetry to remove.
Where should a split whose every route is conditioned continue when it sits inside a loop body or a branch?

## Decision Drivers

- The totality guarantee in ADR-0009: every route keeps a form, and a jump is the fallback for what the catalog cannot fold, never the first answer for a shape it can.
- A modeler draws a condition on every route and names no default, so the shape is the common one, and the invoice example the thesis demonstrates on is an instance of it.
- The guard clause already continues a split at a node the split does not dominate; the rule should extend that rather than add a second continuation mechanism.

## Considered Options

- Continue at the enclosing construct's stop node when a route stays inside it
- Keep every such split as jumps and report it
- Recover the loop body as a region of its own before matching the split

## Decision Outcome

Chosen option: continue at the enclosing construct's stop node when a route stays inside it, because the construct being printed already knows where its region ends, and the dominator queries the clean join uses answer whether a route reaches it.

`emitRoutes` asks for the join in three steps: the clean join, then the guard clause, then the enclosing continuation.
The clean join is refused when the enclosing construct's stop node does not post-dominate it.
Inside a `do` body the body dominates every node behind the loop, so a join behind the loop passes the dominance checks whenever the leaving route and the loop exit share an end, and without the refusal the staying route would be walked past the printed loop head and the back edge dropped.
The enclosing continuation is the stop node the enclosing construct handed down.
It answers only while that node is defined, no route is unconditioned, and at least one route's target is dominated by the split and post-dominated by the stop node.
The chain then walks that route inline, since `branchStaysInRegion` already accepts a target the join post-dominates, and prints the routes that leave the region as jumps.
The walk stops at the stop node, where the enclosing construct carries on.
With an unconditioned route the guard clause still answers first, and outside any enclosing construct the jumps stay, so a split at process level whose every route is conditioned prints as before.

The chain closes with no `else`, so the recompiled split gains a fallback into the join that the model never named; the print reports it, as it does for the same chain at process level.
The loop gateway's own exit condition, `${!clarified}` in the example, prints as the fall-through after `} while (clarified)` and is reported as dropped.

The `review-loop` golden pair freezes the invoice example's shape.
Its split carries a default flow to the join, which the compiled else-less chain gives it and which a hand-drawn original lacks, so the modeler's shape, with a condition on every route and no default anywhere, is pinned in the goto-fallback suite.

### Consequences

- Good, because the invoice example prints its review call inside the loop and the rebuilt process keeps the loop.
- Good, because a cascade of such splits inside one body prints as nested chains, each continuing at the same stop node.
- Good, because the rule reads the model through the dominator queries the clean join already uses and adds no state to the walk.
- Neutral, because a route running straight into the stop node prints as an empty branch, which the validator warns about; the condition on it survives, where a jump would have lost the branch.
- Bad, because a branch that ends inside a loop body, a `do { end } while`, and a jump into a race branch still print as jumps or markers, and stay reported as they are.

### Confirmation

The table in `packages/transform/test/ir-to-dsl.test.ts` under "a split inside a loop body whose every route is conditioned" pins the printed source for one and for two staying routes, and for a leaving route that shares its end with the loop exit, and the whole warning list.
`tests/goto-fallback.round-trip.test.ts` pins the modeler's shape through the XML hop: no marker, and the real-node reachability of the recompiled print equal to the import's plus the two pairs the invented fallback adds.
The `review-loop` round-trip suite pins the frozen artifact byte for byte, its import without a warning, and the chain inside the `do` body.

## Pros and Cons of the Options

### Continue at the enclosing construct's stop node when a route stays inside it

- Good, because the stop node is already threaded through every emitter, so the rule is one arm in `emitRoutes` and one predicate beside `guardClauseContinuation`.
- Good, because the same rule serves a split inside a `while` body, a `do` body, and a branch.
- Bad, because a target the stop node post-dominates but the split does not dominate is walked inline by the chain all the same, the way the guard clause walks it, so a target reached from elsewhere leaves its other edges as jumps.

### Keep every such split as jumps and report it

- Good, because nothing changes and the print reports the drop.
- Bad, because the shape is the common one, and the process the thesis demonstrates on came back running differently.

### Recover the loop body as a region of its own before matching the split

- Good, because a region tree would answer the question for every construct at once.
- Bad, because it is the RPST decomposition ADR-0009 left for later, and the scope does not yet justify it.

## More Information

The predicate is `enclosingContinuation` in `packages/transform/src/ir-to-dsl.ts`; the containment check is in `cleanJoin` beside it.
`emitRoutes` asks a further step between the clean join and the guard clause, `convergence`, which reads where the split's live routes come back together off the model's routes by forward reachability bounded by the stop node, and so answers a split whose branch can end and whose post-dominator therefore lies at the exit.

Amends ADR-0009, whose catalog gains the enclosing continuation beside the clean join and the guard clause.
Amends ADR-0014, whose print hop now walks the route that stays inside a loop body inline and prints the leaving routes alone as jumps, for a split inside a loop body whose every route is conditioned.

Related decisions: ADR-0009 (the catalog this rule extends).
ADR-0036 (the inline terminal in a guard clause, whose region test the chain reuses).
