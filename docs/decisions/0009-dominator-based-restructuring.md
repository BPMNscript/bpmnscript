---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Use Dominator/Post-Dominator Analysis for IR-to-DSL Restructuring

## Context and Problem Statement

The decompile direction (`irToDsl`) must turn a flat BPMN graph (the IR) back into
structured BPMNscript source. The graph may have come from a graphical modeler and
may be structured, partially structured, or entirely unstructured (irreducible).

How should `irToDsl` identify which subgraphs can be expressed as `if`/`while`/
`parallel` blocks, and what should happen for subgraphs that cannot?

## Decision Drivers

* The reconstruction must be **total**: every valid IR must produce a valid DSL
  string, never throw (thesis requirement: the CLI `parse` command must always
  produce output)
* Structured constructs (`if`/`while`/`parallel`) should be recovered where possible
  so the decompiled output is readable and round-trips without information loss
* The algorithm must handle AND fork/join pairs (parallel gateways), not just XOR
* Unstructured graphs (irreducible control flow, cross-branch gotos) must not crash
  the decompiler — they degrade to `goto` statements
* The logic must be isolated and separately testable (not entangled with IR types or
  the grammar)

## Considered Options

* Dominator/post-dominator analysis with a fixed pattern catalogue and `goto` fallback
* RPST (Refined Program Structure Tree) decomposition
* Ad-hoc recursive pattern matching without formal CFG analysis

## Decision Outcome

Chosen option: "Dominator/post-dominator analysis with a fixed pattern catalogue and
`goto` fallback", because it provides a sound, mechanically checkable criterion for
each structured construct and degrades gracefully to `goto` for every edge it cannot
fold, keeping the decompiler unconditionally total.

The pattern catalogue:
- XOR split with a post-dominating join → `if`/`else if`/`else`
- Back-edge from body-exit to a dominating XOR head → `while` (unconditioned
  back-edge) or `do…while` (conditioned back-edge)
- AND fork with a matching AND join → `parallel { } and { }`
- Every other edge → `goto <targetId>`

### Consequences

* Good, because the algorithm terminates and produces valid DSL for every IR (total
  over the supported scope)
* Good, because AND fork/join pairs are recovered as `parallel` blocks without
  special-casing the decompiler
* Good, because the CFG analysis (`cfg-analysis.ts`) is a pure, stateless utility
  with its own test suite — it can be audited independently of the emitter
* Neutral, because RPST would recover more structured patterns (e.g. nested
  switch-like gotos) but is left for later, once the scope justifies the added machinery
* Bad, because topology-based back-edge disambiguation (while vs. do-while) requires
  checking the `conditionExpression` field, not just graph shape

### Confirmation

`irToDsl` is verified total by the unit test suite (`packages/transform/test/`):
every test input produces a string (never throws). The goto-degradation path is
confirmed by `tests/golden/unstructured-goto.bpmn` in `tests/round-trip-constructs.test.ts`.

## More Information

The CFG analysis utility lives at `packages/transform/src/cfg-analysis.ts` and
exposes `analyzeCfg(process): CfgAnalysis` with `immediateDominator`,
`immediatePostDominator`, `dominates`, `postDominates`, `backEdges`, `outgoing`,
and `incoming` queries. `VIRTUAL_ENTRY` and `VIRTUAL_EXIT` constants are used to
give the dominator algorithm a unique single entry/exit.

RPST decomposition is left for later: it would recover more structured patterns,
but the dominator-based catalogue with a `goto` fallback already covers the current
scope, so the added machinery is not yet justified.
