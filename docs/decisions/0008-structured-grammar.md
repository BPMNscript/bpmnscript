---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# Use a Structured, Code-Like Grammar

## Context and Problem Statement

A BPMN DSL can expose its surface syntax in two broad shapes. One is a flat
declaration-plus-edges form: every flow node (`start`, `user`, `gateway`,
`service`, `end`) is declared at the top level, and explicit `->` edges (with
`when:`, `as:`, `default:`) connect them. This maps directly to the BPMN graph
model, but it reads like a diagram description rather than code, and offers little
advantage over editing BPMN XML for developers who think in control-flow terms.
The other is a structured, code-like language with implicit sequence flow and
block-scoped control statements.

Which surface should BPMNscript use: a flat graph declaration, or a structured,
code-like language with implicit sequence flow and block-scoped control statements?

## Decision Drivers

* The thesis goal is a textual DSL that serves developers who prefer working in code
* IDE support — inline errors, type-aware validation, jump-to-definition — is far
  richer for a real expression AST than for opaque condition strings
* Authoring a flat graph requires the same mental model as a BPMN diagram; a
  structured language is closer to how developers already write sequential logic
* The round-trip direction (BPMN XML → DSL) needs a `goto`-capable fallback for
  unstructured graphs — the structured surface naturally accommodates this
* A JUEL-subset expression sub-language parsed to a real AST is needed to enable
  type-check diagnostics on condition expressions (thesis rule 15: IDE support is
  the entire value proposition)

## Considered Options

* Structured code-like syntax (keyword + braces, implicit flow, `if`/`while`/`parallel`/`goto`)
* A flat node/edge syntax (explicit declarations + `->` edges, mapping 1:1 to the BPMN graph)
* Hybrid: named blocks for common patterns, with a fallback to explicit edges

## Decision Outcome

Chosen option: "Structured code-like syntax", because it aligns the DSL with how
developers reason about sequential control flow, enables a real expression AST for
rich LSP diagnostics, and provides a natural home for `goto` as a decompilation
fallback for unstructured BPMN graphs.

### Consequences

* Good, because the DSL reads and writes like program code (`if`/`while`/`parallel`)
* Good, because conditions are a first-class expression AST, enabling type-check
  validation and jump-to-definition for variable references
* Good, because `parallel { } and { }` maps directly to AND fork/join pairs, making
  parallel-gateway support natural to author
* Good, because `goto` as a residual form keeps decompilation total: every valid
  BPMN graph has a valid DSL representation
* Bad, because the desugaring (`astToIr`) must synthesize gateway pairs from block
  structure, adding complexity relative to a flat pass-through that mirrors the graph
  directly

### Confirmation

The construct round-trip idempotence test (`tests/round-trip-constructs.test.ts`)
verifies that every structured construct (`if`/`else`, `while`, `parallel`) survives
`astToIr → irToXml → xmlToIr → irToDsl` without losing structure. The goto-degradation
path is exercised by `tests/golden/unstructured-goto.bpmn` in the same suite.

## More Information

The JUEL-subset boundary (what parses natively vs. falls back to `"${…}"`) is fixed
by the grammar's expression sub-rules in `packages/language/src/bpmn-script.langium`
and mirrored by the hand-rolled parser in `packages/transform/src/juel.ts`.
