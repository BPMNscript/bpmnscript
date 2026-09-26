---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Restructure the IR into a DSL with dominator analysis

## Context and Problem Statement

The decompile direction (`irToDsl`) must turn a flat BPMN graph (the IR) back into structured BPMNscript source.
The graph may have come from a graphical modeler and may be structured, partially structured, or entirely unstructured (irreducible).

How should `irToDsl` decide which subgraphs can be phrased as `if`, `while`, `parallel` or `await` blocks, what form the routes it cannot fold take, and what happens to a region it cannot phrase at all?

## Decision Drivers

- The reconstruction must be total: every valid IR must produce a valid DSL string and never throw, because the CLI `parse` command must always produce output.
- Structured constructs should be recovered wherever the graph allows it, so the decompiled output is readable and round-trips without information loss.
- The analysis must handle AND fork and join pairs (parallel gateways), not just XOR.
- Unstructured graphs (irreducible control flow, cross-branch jumps) must not crash the decompiler; they degrade to `goto` statements.
- A jump is the fallback for what the catalog cannot fold, never the first answer for a shape it can fold.
- A report describes what runs differently and nothing else, so a print that routes the way the model routes draws none, and what the marker line and the warnings channel say has to be enough to start a hand repair, so a lost split names itself in the source.
- The page says what the graph does.
  Statements run top to bottom and the flow between them is never written out, so a statement missing from the page is a flow the reader cannot see.
- The honest import contract (ADR-0012): what the round trip cannot carry is reported, never dropped without a word.
- The logic must be isolated and separately testable, not entangled with IR types or the grammar.

## Considered Options

- Dominator and post-dominator analysis with a fixed pattern catalog and a `goto` fallback: each construct gets a criterion that reads the graph rather than a heuristic, and the fallback is a form the language already has, so totality costs no new syntax.
- RPST (Refined Program Structure Tree) decomposition: a region tree would recover more structured patterns and would answer the continuation question for every construct at once, but the catalog with a `goto` fallback already covers the current scope.
- Ad-hoc recursive pattern matching without formal control-flow analysis: there is no criterion to check a match against, so an unstructured graph has no defined outcome and the decompiler is free to loop or to throw.
- An `if` chain for a step with more than one route out, and jumps carrying no conditions where a split degrades: the print of a common modeler shape, a task with two plain flows, then runs one route where the model runs both, and a degraded split's conditions are discarded with no marker for the reader to find.
- Refusing a step with more than one outgoing flow on import: the printer never sees the shape, but the engine deploys and runs it, and the import contract refuses only what the engine refuses or what changes a stored value.
- Keeping a split whose every route is conditioned as jumps wherever it sits: the print reports the drop and no rule is added, but a condition on every route with no default named is the common modeler shape, and the process the thesis demonstrates on came back running differently.
- Deferring the chain that holds an elided synthesized end to the last position in its block: it conflicts with the elided-start-first rule whenever one chain holds both, only one chain can be last where there are several elided ends, and printing the end in place covers every shape it would.

## Decision Outcome

Chosen option: dominator and post-dominator analysis with a fixed pattern catalog and a `goto` fallback, because dominator analysis gives a mechanically checkable criterion for each structured construct, and the edges the catalog cannot fold degrade to `goto` instead of to a failure.

The analysis is `analyzeCfg(process): CfgAnalysis`, a pure function over the IR with `immediateDominator`, `immediatePostDominator`, `dominates`, `postDominates`, `backEdges`, `outgoing` and `incoming` queries.
`VIRTUAL_ENTRY` and `VIRTUAL_EXIT` give the dominator algorithm a unique single entry and exit.

The pattern catalog:

- XOR split with a post-dominating join -> `if`/`else if`/`else`
- Statement with more than one route out -> the fork block the engine runs it as, inclusive or parallel
- Unconditioned back-edge from a body exit to the XOR head dominating it -> `while`, the loop condition read from the head's edge into the body
- Conditioned back-edge from an XOR head to the body entry dominating it -> `do...while`, the loop condition read from the back-edge itself
- AND fork with a matching AND join -> `parallel { { } { } }`
- OR fork with a matching OR join -> the same `parallel` block with each conditioned branch headed by its condition, and the fallback flow heading a branch as `else`.
  A fallback that runs straight into the join is left out where enough branches remain to fill the block, and prints as an empty `else` where dropping it would leave too few.
- Event-based gateway whose every outgoing flow reaches an intermediate catch event -> `await { ... }` with one branch per catch, continuing at the exclusive merge the branches share when they have one
- Every other edge -> `goto <targetId>`, or a dropped-edge marker where the edge has no name to jump to

A gateway a pattern folds is never printed, which is what keeps the round trip idempotent.

`emitRoutes` asks where a split's routes come back together in four steps.
The clean join is the post-dominator the split dominates, refused when the enclosing construct's stop node does not post-dominate it, since inside a `do` body the body dominates every node behind the loop, so a join behind the loop would otherwise pass the dominance checks whenever a leaving route and the loop exit share an end.
`convergence` reads where the split's live routes come back together off the model's routes by forward reachability bounded by the stop node, and so answers a split whose branch can end and whose post-dominator therefore lies at the exit.
The guard clause answers when exactly one route is unconditioned, that route being the continuation; it admits a bare authored terminal as a branch entry when the split's route is the terminal's only incoming flow, so the terminal prints inside the `if` rather than as a `goto` with a trailing statement, and it admits a gateway the split dominates, which a jump could not name anyway.
The enclosing continuation is the stop node the enclosing construct handed down, and answers only while that node is defined, no route is unconditioned, and at least one route's target is dominated by the split and post-dominated by the stop node; the chain then walks that route inline, prints the routes that leave the region as jumps, and stops at the stop node where the enclosing construct carries on.
The same rule serves a split inside a `while` body, a `do` body and a branch, including a split inside a guarded branch.
Outside any enclosing construct the jumps stay, so a split at process level whose every route is conditioned prints as jumps, closing with no `else`, so the recompiled split gains a fallback into the join that the model never named, and the print reports it.
A loop gateway's own exit condition prints as the fall-through after the `} while (...)` line and is reported as dropped.
Every route of a folded exclusive split gets a form: a condition heads its branch, and a route carrying none heads a branch as `true`, takes the chain's `else`, or runs straight into the join as the chain's fall-through, since heading that last route instead would put a `true` over an empty branch and leave the rest of the chain unreachable.

`followLinear` reads a step's routes off the model, and two or more hand the step to the fork printer as its split, since `BpmnActivityBehavior.performOutgoingBehavior` leaves a step by every flow whose condition holds or that carries none, and by the flow the step names as `default` only when none was taken.
The block is inclusive when any route carries a condition or the step names a `default`, the rule `InclusiveGatewayActivityBehavior.execute` applies to a gateway of that kind, and parallel otherwise, with the `default` as the block's `else`.
The one shape a choice routes the same way, exactly one weighed route beside the `default`, keeps the `if`/`else` the choice prints, which reads better and lowers to the same routing.
The fork printer is keyed on a split's id and kind rather than on a gateway, so a step's block takes the merge's `join` settings and no head settings of its own.

A fork or race the catalog cannot fold prints one marker line naming the split and its kind, `split G degraded to jumps; was inclusive`, and then an `if` chain of jumps with each route's condition on its own jump and the split's fallback as the `else`, each jump taking a branch of that chain since a jump ends its block and a second one beside it could never run.
The report says the conditions are on the jumps and that the split's kind, whether it opened one branch, every branch whose condition held, or the first to resolve, is written nowhere.
An exclusive split with no clean join prints its jumps with no marker: an `if` chain of jumps is a choice, and an exclusive split takes the first route whose condition holds (`ExclusiveGatewayActivityBehavior.doLeave`), so nothing of it is lost.

A gateway with no route out prints nothing and is reported by kind, the report naming what the model does there: a parallel gateway ends the run as the script's block end does (`ParallelGatewayActivityBehavior.execute` leaves by no route and `PvmExecutionImpl.leaveActivityViaTransitions` ends the execution), an inclusive gateway stops with an error (`InclusiveGatewayActivityBehavior.execute` throws `stuckExecutionException`), an event-based gateway waits forever with nothing to wait for, and an exclusive gateway keeps the model from deploying (`BpmnParse.validateExclusiveGateway`), which the import refuses ahead of the printer, so that last report covers hand-built IR alone.
The loop patterns ignore a back edge whose source is its target, so such a gateway prints as a choice whose route back into itself has no name and takes the dropped-edge marker, while its exit route keeps its condition.
An event sub-process a flow edge leads into is malformed IR and the printer throws, as it does on a duplicate id; the import refuses the flow ahead of it.

Some edges have no `goto` form at all.
An edge arriving at a gateway that still chooses between branches cannot be named, because a `goto` names a statement and a gateway has none, so the jump is only expressible through the gateway's successor and only while the routing has a single outcome.
An edge whose target the printer elides cannot be named either, the elided element leaving no statement behind for a jump to spell.
Such an edge is dropped, a marker comment is printed where it would have gone naming the element it led into, and `irToDsl` reports the drop on a warnings channel of its own.
The marker comment stays in the printed source, where it is the reader's pointer to the place needing repair.
The branch walk records the `await` or `parallel` branch each statement is printed in, as the path of branch ids from the outermost block down, and every jump records the path it was printed under.
Once the walk is done, a jump whose target sits in a branch the jump's path does not begin with is reported, since the validator refuses a `goto` into a branch from outside it: a branch's steps run only when the whole block is reached.
The jump is written all the same; the model is where the route comes from.

A plain end event whose id carries a synthesized prefix and holds nothing printable is left out only where it is its block's tail, at its block's own depth with no flow statement of the same block printed after it.
The compiler mints such an end in `lowerContainerBody` and `lowerBoundaryHandler`, both at the tail of a block, and never inside a branch or loop body, whose exit it wires to the join or the loop head instead, so only at a tail does reading the source back re-derive the same terminal.
`isElidedOnPrint` stays the model-level predicate and keeps answering "the printer may drop this end", which `warnRefusedStatements`, `forwardToRealTarget` and the importer's `warnElidedNamedDrop` read.
Whether the printer does drop the end is a fact about print order, known only once every chain of the block is on the page, so that half of the decision sits in the emitter: `emitNode` records the end with the position it would have printed at, and `Emitter.emit` then leaves out an end nothing followed and splices any other back at its position, with one report per printed end, in page order.
The printed source draws exactly one validator error, on the printed `end` line, and renaming the id in the model makes the source clean and round-trips the document structurally unchanged.
The import warning on a labelled plain end describes both outcomes, since the importer cannot know which position the printer will give an end: where the script can do without the end it is left out and its label with it, and anywhere else it prints under a name the script refuses.
Either way the fix it names is a rename in the diagram.

### Consequences

- Good, because the algorithm terminates and produces parseable DSL for every IR, total over the supported scope, and the fallback costs the language no new syntax.
- Good, because AND fork and join pairs are recovered as `parallel` blocks without special-casing the decompiler.
- Good, because a step with two plain routes or with a weighed route beside a plain one round-trips to the routing the engine runs, with no report.
- Good, because the conditions of a degraded split survive on its jumps, and the marker line puts the reader at the split rather than leaving the jumps to explain themselves.
- Good, because the fork printer, the invented-fallback report and the fallback-condition report each have one home, and a gateway and a step share it.
- Good, because the CFG analysis is a pure, stateless utility with its own test suite, auditable independently of the emitter, and the same dominator queries answer the clean join, the guard clause and the enclosing continuation.
- Good, because a split whose every route is conditioned inside a loop body prints its staying routes inline, so the Operaton invoice example prints its review call inside the loop and the rebuilt process keeps the loop.
  A cascade of such splits inside one body prints as nested chains, each continuing at the same stop node, and the rule adds no state to the walk.
- Good, because the restructurer reports what it drops instead of leaving the caller to find it, including where the drop changes what a recompiled document runs.
  A fallback re-derived on an imported OR fork that named none is one such report: `InclusiveGatewayActivityBehavior` throws a stuck execution when every branch of such a fork carries a condition and none of them holds, while the printed block falls through, so a document recompiled from that script runs on where the model would have stopped.
- Good, because a synthesized plain end that is not its block's tail is refused loudly instead of rewiring its chain into whatever the printer appended next: the reader finds a reserved id on the page, a print warning, and a validator error naming the element to rename.
- Neutral, because a route running straight into an enclosing construct's stop node prints as an empty branch, which the validator warns about; the condition on it survives, where a jump would have lost the branch.
- Neutral, because a step whose routes reconverge at a merge of another kind, or at a step, degrades to jumps under the marker: the block form synchronizes at a merge of its own kind, which the model does not have there.
- Neutral, because a jump into an elided end is still dropped and marked.
  `forwardToRealTarget` reads the model-level answer, and at the top level the jump is printed before the end's position is known; for a plain end in the same container the re-derived tail end is the same terminal, so the process runs the same and the marker is the only cost.
- Neutral, because RPST would recover more structured patterns, for example nested switch-like gotos, but is left for later, once the scope justifies the added machinery.
- Bad, because topology-based back-edge disambiguation, `while` against `do...while`, requires checking the `conditionExpression` field, not just graph shape.
- Bad, because a target the stop node post-dominates but the split does not dominate is walked inline by the chain all the same, the way the guard clause walks it, so a target reached from elsewhere leaves its other edges as jumps.
- Bad, because "tail" for a synthesized end is decidable only after the block's passes, so the emitter carries a deferred list and a resolve step that a reader has to find.
- Bad, because the decompiler always produces parseable source but not always source that validates, and not every edge survives.
- Bad, because a modeller's document with a default-named plain end that is not last prints a reserved id and is refused until renamed, and the import-side label warning can only name the two outcomes rather than the one that will happen.
- Bad, because a step whose routes merge at a merge of another kind prints jumps under a marker where an `if` chain would read better, that chain being a choice the model is not.
- Bad, because a branch that ends inside a loop body, a `do { end } while`, a loop gateway the compiler leaves without an incoming flow, and a post-test loop whose body ends inside a branch still print as jumps or markers, the last of them a jump the validator refuses; these are reported and pinned as they are.

### Confirmation

`irToDsl` is verified total by the unit test suite (`packages/transform/test/`): every test input produces source and its warnings, and never throws.
The goto-degradation path is confirmed by `tests/golden/unstructured-goto.bpmn` in `tests/round-trip-constructs.test.ts`.
The tables in `packages/transform/test/ir-to-dsl.test.ts` pin the printed source, the whole warning list, the re-parse and the real-node reachability for each shape above: a step whose own routes split, the degraded marker with its weighed jumps, the empty-split report per gateway kind, the self-looping gateway, the jump across a branch border, the guard clause, a split inside a loop body whose every route is conditioned, and a synthesized plain end that is not its block's tail.
`tests/goto-fallback.round-trip.test.ts` runs the composite shapes a fuzz run drew through compile, export, import and print, pinning each print's warning categories and whether it validates, and pins the modeler's shape of a conditioned split in a loop through the XML hop.
The `review-loop` round-trip suite pins the frozen artifact byte for byte, its import without a warning, and the chain inside the `do` body, and every round-trip suite under `tests/` validates the source printed from its golden with zero error diagnostics, which is the proof that no golden's printed form moved.

## More Information

The CFG analysis lives at `packages/transform/src/cfg-analysis.ts`.
In `packages/transform/src/ir-to-dsl.ts`, `emitRoutes` chooses the continuation, `cleanJoin` holds the containment check, `convergence` and `enclosingContinuation` sit beside it, `branchStaysInRegion` decides a guard clause's branch entry, `followLinear` reads a step's routes, `emitFork` prints a fork block, `emitJumps` the degraded chain, `emptySplitWarning` the report for a gateway with no route out, and `emitBranch` with the check at the end of `Emitter.emit` does the branch bookkeeping for a jump across a branch border.
Each print warning category and what it costs is listed in `packages/transform/README.md`.
