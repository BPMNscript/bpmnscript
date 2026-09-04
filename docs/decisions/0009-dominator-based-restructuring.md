---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Use Dominator/Post-Dominator Analysis for IR-to-DSL Restructuring

## Context and Problem Statement

The decompile direction (`irToDsl`) must turn a flat BPMN graph (the IR) back into structured BPMNscript source.
The graph may have come from a graphical modeler and may be structured, partially structured, or entirely unstructured (irreducible).

How should `irToDsl` identify which subgraphs can be expressed as `if`/`while`/`parallel` blocks, and what should happen for subgraphs that cannot?

## Decision Drivers

- The reconstruction must be total: every valid IR must produce a valid DSL string and never throw, because the CLI `parse` command must always produce output
- Structured constructs (`if`/`while`/`parallel`) should be recovered where possible so the decompiled output is readable and round-trips without information loss
- The algorithm must handle AND fork/join pairs (parallel gateways), not just XOR
- Unstructured graphs (irreducible control flow, cross-branch gotos) must not crash the decompiler; they degrade to `goto` statements
- The logic must be isolated and separately testable, not entangled with IR types or the grammar

## Considered Options

- Dominator/post-dominator analysis with a fixed pattern catalog and `goto` fallback
- RPST (Refined Program Structure Tree) decomposition
- Ad-hoc recursive pattern matching without formal CFG analysis

## Decision Outcome

Chosen option: "Dominator/post-dominator analysis with a fixed pattern catalog and `goto` fallback".
Dominator analysis gives a mechanically checkable criterion for each structured construct, and most edges the catalog cannot fold degrade to `goto`.
A statement with more than one route out prints as an `if` chain, because a statement is one position with one way on and a jump written beside the fall-through would end the block, cutting off the chain that fall-through carries.
Every route gets a form: a condition heads its branch, and a route carrying none heads a branch as `true`, takes the chain's `else`, or runs straight into the join as the chain's fall-through.
Heading that last route instead would put a `true` over an empty branch and leave the rest of the chain unreachable.
Where a split degrades instead, its routes leave as jumps, and each jump takes a branch of such a chain, since a jump ends its block and a second one written beside the first could never run.
Some edges have no `goto` form at all.
An edge arriving at a gateway that still chooses between branches cannot be named, because a `goto` names a statement and a gateway has none, so the jump is only expressible through the gateway's successor and only while the routing has a single outcome.
An edge whose target the printer elides cannot be named either, the elided element leaving no statement behind for a jump to spell.
Such an edge is dropped, a marker comment is printed where it would have gone naming the element it led into, and `irToDsl` reports the drop on a warnings channel of its own.
The marker comment stays in the printed source, where it is the reader's pointer to the place needing repair.

The pattern catalog:

- XOR split with a post-dominating join -> `if`/`else if`/`else`
- Statement with more than one route out -> the same `if` chain, a conditioned route heading a branch and an unconditioned route running straight into the join taken as the chain's fall-through
- Unconditioned back-edge from a body exit to the XOR head dominating it -> `while`, the loop condition read from the head's edge into the body
- Conditioned back-edge from an XOR head to the body entry dominating it -> `do...while`, the loop condition read from the back-edge itself
- AND fork with a matching AND join -> `parallel { { } { } }`
- OR fork with a matching OR join -> the same `parallel` block with each conditioned branch headed by its condition, and the fallback flow heading a branch as `else`.
  A fallback that runs straight into the join is left out where enough branches remain to fill the block, and prints as an empty `else` where dropping it would leave too few.
- Event-based gateway whose every outgoing flow reaches an intermediate catch event -> `await { ... }` with one branch per catch, continuing at the exclusive merge the branches share when they have one
- Every other edge -> `goto <targetId>`, or a dropped-edge marker where the edge has no name to jump to

A gateway a pattern folds is never printed, which is what keeps the round trip idempotent.

### Consequences

- Good, because the algorithm terminates and produces parseable DSL for every IR (total over the supported scope)
- Good, because AND fork/join pairs are recovered as `parallel` blocks without special-casing the decompiler
- Good, because the CFG analysis (`cfg-analysis.ts`) is a pure, stateless utility with its own test suite, so it can be audited independently of the emitter
- Good, because the restructurer reports what it drops instead of leaving the caller to find it, including where the drop changes what a recompiled document runs.
  A fallback re-derived on an imported OR fork that named none is one such report: Operaton's `InclusiveGatewayActivityBehavior` throws a stuck execution when every branch of such a fork carries a condition and none of them holds, while the printed block falls through, so a document recompiled from that script runs on where the model would have stopped.
  A split whose branches the catalog cannot fold is reported too, its edges written as jumps, and a jump ends the path it sits on where the split opened several.
- Neutral, because RPST would recover more structured patterns (for example nested switch-like gotos) but is left for later, once the scope justifies the added machinery
- Bad, because topology-based back-edge disambiguation (while versus do-while) requires checking the `conditionExpression` field, not just graph shape
- Bad, because the decompiler always produces parseable source but not always source that validates, and not every edge survives
- Bad, because a statement whose own routes split prints as an `if` chain, which takes one route where the model takes every route it can at once, so what a recompiled document runs changes; the print hop reports it

### Confirmation

`irToDsl` is verified total by the unit test suite (`packages/transform/test/`): every test input produces source and its warnings, and never throws.
The goto-degradation path is confirmed by `tests/golden/unstructured-goto.bpmn` in `tests/round-trip-constructs.test.ts`.

## More Information

The CFG analysis utility lives at `packages/transform/src/cfg-analysis.ts` and exposes `analyzeCfg(process): CfgAnalysis` with `immediateDominator`, `immediatePostDominator`, `dominates`, `postDominates`, `backEdges`, `outgoing`, and `incoming` queries.
`VIRTUAL_ENTRY` and `VIRTUAL_EXIT` constants give the dominator algorithm a unique single entry and exit.

RPST decomposition is left for later.
It would recover more structured patterns, but the dominator-based catalog with a `goto` fallback already covers the current scope, so the added machinery is not yet justified.
