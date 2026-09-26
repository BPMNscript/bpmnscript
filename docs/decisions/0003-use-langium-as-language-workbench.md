---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use Langium as Language Workbench

## Context and Problem Statement

BPMNscript is a textual DSL that requires a parser, AST, validation, scoping, and IDE integration (syntax highlighting, autocomplete, jump-to-definition, inline errors) delivered as a VS Code extension.
Which language workbench should be used to implement the DSL infrastructure?

## Decision Drivers

- The primary IDE target had to be Visual Studio Code or IntelliJ, the author's two familiar, high-adoption editors, with first-class extension support
- IDE features (syntax highlighting, autocomplete, jump-to-definition, inline errors) are a core value proposition of a textual DSL
- A 15-week thesis timeline requires fast bootstrapping and minimal boilerplate
- A post-thesis browser-based playground should be architecturally feasible
- The workbench must support custom scoping, validation, and code generation to BPMN 2.0 XML
- Error-tolerant incremental parsing is required for real-time editor feedback

## Considered Options

- Langium: TypeScript throughout, with built-in scoping, cross-reference resolution and validation infrastructure, and a Chevrotain parser with unbounded (ALL(\*)) lookahead.
- Eclipse Xtext: the most mature workbench (20 years), with EMF integration giving native access to the BPMN 2.0 metamodel and a built-in AST-to-text serializer, but VS Code support needs a hybrid Java/TypeScript stack with a JVM backend, no browser deployment path exists, the learning curve is steep (EMF, Guice, Xtend, Eclipse, MWE2), and its maintenance future has been in question since a 2020 sustainability discussion.
- MontiCore: has an existing BPMN Workflow DSL grammar, auto-generates pretty printers from grammars, and has strong language composition (inheritance, embedding, aggregation), but has no LSP support, no VS Code integration path, and no browser deployment path.
- ANTLR with a manual LSP server: the most widely used parser generator, with full control and no framework lock-in, and grammar-aware completion via `antlr4-c3`, but every IDE feature would need to be implemented by hand, an estimated 3-5 weeks of the timeline, with no generated VS Code extension scaffolding.
- JetBrains MPS: backed by JetBrains, with trivial language composition in its projectional editor, but it stores files as XML rather than human-readable text, has no VS Code or LSP integration, and is architecturally incompatible with a textual DSL.

## Decision Outcome

Chosen option: "Langium", primarily for its own ergonomics: a smaller, more approachable toolchain than Xtext's, and native access to the existing TypeScript BPMN tooling this project builds on: `bpmn-moddle` to read and write BPMN 2.0 XML, and `bpmn-auto-layout` to generate the Diagram Interchange (DI) data a textual syntax has no coordinate system to produce by hand.
The IDE target followed from this choice rather than preceding it: Langium's TypeScript toolchain generates an LSP server and VS Code extension directly from the grammar, which made Visual Studio Code the easier of the two viable targets to reach, whereas an IntelliJ plugin for Xtext would not have benefited from that same generation path.
Browser deployment for a future playground was a secondary factor, all within a timeline-feasible learning curve.

### Consequences

- Good, because the entire stack is TypeScript, eliminating context-switching between languages
- Good, because Langium generates parser, AST, syntax highlighting, completion, go-to-definition, and diagnostics from the grammar
- Good, because the language server can run in a web worker, enabling a browser-based playground with approximately 95% code reuse
- Good, because `bpmn-moddle` (the standard TypeScript library for BPMN 2.0 XML) integrates naturally
- Good, because Langium is actively maintained by TypeFox as an Eclipse Foundation mature project
- Bad, because Langium has no built-in AST-to-text serializer, requiring a handwritten emitter for the BPMN-to-DSL reverse transformation
- Bad, because documentation has gaps for advanced topics such as custom scoping patterns
- Neutral, because Langium is younger (5 years) than Xtext (20 years), meaning some edge cases are less tested

## More Information

Twelve workbenches were evaluated in total.
Beyond the five listed above, Spoofax, Rascal, Racket, Neverlang, textX, Chevrotain, and Kotlin+ANTLR+lsp4j were assessed and excluded for reasons including: lack of production-ready VS Code support, abandoned IDE tooling, architectural mismatch (S-expression syntax, projectional editing), or infeasible learning curves for a 15-week timeline.

Sources for the comparison:

- [TypeFox: Xtext, Langium, what next?](https://www.typefox.io/blog/xtext-langium-what-next/)
- [Langium 4.0 Release](https://www.typefox.io/blog/langium-release-4.0/)
- [Call To Action: Secure the future maintenance of Xtext (GitHub #1721)](https://github.com/eclipse-xtext/xtext/issues/1721)
- [Jordan & Zib: A Langium-based approach to BigER (TU Wien, 2024)](https://model-engineering.info/publications/theses/thesis-jordan-zib.pdf)
