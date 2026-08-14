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

- Dominator/post-dominator analysis with a fixed pattern catalogue and `goto` fallback
- RPST (Refined Program Structure Tree) decomposition
- Ad-hoc recursive pattern matching without formal CFG analysis

## Decision Outcome

Chosen option: "Dominator/post-dominator analysis with a fixed pattern catalogue and `goto` fallback".
Dominator analysis gives a mechanically checkable criterion for each structured construct, and most edges the catalogue cannot fold degrade to `goto`.
Two kinds have no `goto` form at all.
An edge arriving at a gateway that still chooses between branches cannot be named, because a `goto` names a statement and a gateway has none, so the jump is only expressible through the gateway's successor and only while the routing has a single outcome.
A surplus out-edge cannot be placed, because a statement carries exactly one fall-through and a jump written beside it would cut that fall-through off.
Such an edge is dropped, a marker comment is printed where it would have gone naming the element it led into, and the CLI reports the marker as a warning.

The pattern catalogue:

- XOR split with a post-dominating join -> `if`/`else if`/`else`
- Back-edge from body-exit to a dominating XOR head -> `while` (unconditioned back-edge) or `do...while` (conditioned back-edge)
- AND fork with a matching AND join -> `parallel { { } { } }`
- Every other edge -> `goto <targetId>`, or a dropped-edge marker when the edge has neither a name nor a position

### Consequences

- Good, because the algorithm terminates and produces parseable DSL for every IR (total over the supported scope)
- Good, because AND fork/join pairs are recovered as `parallel` blocks without special-casing the decompiler
- Good, because the CFG analysis (`cfg-analysis.ts`) is a pure, stateless utility with its own test suite, so it can be audited independently of the emitter
- Neutral, because RPST would recover more structured patterns (for example nested switch-like gotos) but is left for later, once the scope justifies the added machinery
- Bad, because topology-based back-edge disambiguation (while versus do-while) requires checking the `conditionExpression` field, not just graph shape
- Bad, because the decompiler always produces parseable source but not always source that validates, and not every edge survives: a loop whose condition sits on the back-edge is ordinary BPMN that no pattern matches, and its back-edge is lost with a marker rather than reproduced
- Bad, because a surplus out-edge that is written as a `goto` ends the chain it sits in, so the statements after it can fail the unreachable-statement check

### Confirmation

`irToDsl` is verified total by the unit test suite (`packages/transform/test/`): every test input produces a string and never throws.
The goto-degradation path is confirmed by `tests/golden/unstructured-goto.bpmn` in `tests/round-trip-constructs.test.ts`.

## More Information

The CFG analysis utility lives at `packages/transform/src/cfg-analysis.ts` and exposes `analyzeCfg(process): CfgAnalysis` with `immediateDominator`, `immediatePostDominator`, `dominates`, `postDominates`, `backEdges`, `outgoing`, and `incoming` queries.
`VIRTUAL_ENTRY` and `VIRTUAL_EXIT` constants give the dominator algorithm a unique single entry and exit.

RPST decomposition is left for later.
It would recover more structured patterns, but the dominator-based catalogue with a `goto` fallback already covers the current scope, so the added machinery is not yet justified.
