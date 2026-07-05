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

- VS Code must be the primary IDE target, with first-class extension support
- IDE features (syntax highlighting, autocomplete, jump-to-definition, inline errors) are a core value proposition of a textual DSL
- A 15-week thesis timeline requires fast bootstrapping and minimal boilerplate
- A post-thesis browser-based playground should be architecturally feasible
- The workbench must support custom scoping, validation, and code generation to BPMN 2.0 XML
- Error-tolerant incremental parsing is required for real-time editor feedback

## Considered Options

- Langium
- Eclipse Xtext
- MontiCore
- ANTLR with manual LSP server
- JetBrains MPS

## Decision Outcome

Chosen option: "Langium", because it is the only workbench that natively targets VS Code with TypeScript, generates an LSP server and VS Code extension from a grammar definition, and supports browser deployment for a future playground -- all within a timeline-feasible learning curve.

### Consequences

- Good, because the entire stack is TypeScript, eliminating context-switching between languages
- Good, because Langium generates parser, AST, syntax highlighting, completion, go-to-definition, and diagnostics from the grammar
- Good, because the language server can run in a web worker, enabling a browser-based playground with approximately 95% code reuse
- Good, because `bpmn-moddle` (the standard TypeScript library for BPMN 2.0 XML) integrates naturally
- Good, because Langium is actively maintained by TypeFox as an Eclipse Foundation mature project
- Bad, because Langium has no built-in AST-to-text serializer, requiring a handwritten emitter for the BPMN-to-DSL reverse transformation
- Bad, because documentation has gaps for advanced topics such as custom scoping patterns
- Neutral, because Langium is younger (5 years) than Xtext (20 years), meaning some edge cases are less tested

## Pros and Cons of the Options

### Langium

<https://langium.org/>

- Good, because it generates a full LSP server and VS Code extension from a single grammar file
- Good, because it uses TypeScript throughout -- the same language for grammar processing, validation, code generation, and the VS Code extension
- Good, because it natively supports browser deployment via web workers and Monaco Editor
- Good, because it provides built-in scoping, cross-reference resolution, and validation infrastructure
- Good, because it is actively developed (v4.2, February 2026) with TypeFox as primary maintainer
- Good, because the Chevrotain parser uses the ALL(\*) algorithm for unbounded lookahead
- Bad, because there is no built-in AST-to-text serializer for round-tripping
- Bad, because documentation is thinner than Xtext's, especially for advanced scoping and Sprotty integration
- Bad, because it has no grammar-level enum construct

### Eclipse Xtext

<https://eclipse.dev/Xtext/>

- Good, because it is the most mature DSL workbench (20 years, v2.42)
- Good, because it has a built-in serializer for AST-to-text round-tripping
- Good, because its EMF integration provides native access to the BPMN 2.0 metamodel
- Good, because it has extensive documentation, books, and community resources
- Bad, because its maintenance future is at risk (declining contributors, open sustainability discussion since 2020)
- Bad, because VS Code support requires a hybrid Java/TypeScript stack with a JVM backend process
- Bad, because no viable browser deployment path exists (Java server required)
- Bad, because the learning curve is steep (EMF, Guice, Xtend, Eclipse, MWE2)
- Bad, because the build system (Maven Tycho, Eclipse target platforms) is frequently reported as fragile

### MontiCore

<https://monticore.github.io/monticore/>

- Good, because it has an existing BPMN Workflow DSL grammar
- Good, because it auto-generates pretty printers from grammars
- Good, because it has the strongest language composition capabilities (inheritance, embedding, aggregation)
- Bad, because it has no LSP support and no VS Code integration path
- Bad, because it has no browser deployment path (19 MB JAR, reflection-heavy)
- Bad, because its community is effectively limited to RWTH Aachen
- Bad, because documentation is academic and sparse outside the handbook

### ANTLR with manual LSP server

<https://www.antlr.org/>

- Good, because ANTLR is the most widely used and cited parser generator
- Good, because it provides full control with no framework lock-in
- Good, because the `antlr4-c3` library provides grammar-aware code completion
- Bad, because every IDE feature (scoping, validation, completion, go-to-definition) must be implemented manually
- Bad, because the estimated time to a working LSP server is 3-5 weeks, consuming most of the implementation timeline
- Bad, because there is no generated VS Code extension scaffolding

### JetBrains MPS

<https://www.jetbrains.com/mps/>

- Good, because it is backed by JetBrains and actively maintained
- Good, because language composition is trivial in a projectional editor
- Bad, because it is a projectional editor, not a textual DSL workbench -- files are stored as XML, not human-readable text
- Bad, because it has no VS Code support and no LSP integration
- Bad, because it is architecturally incompatible with the thesis goal of a textual DSL

## More Information

Twelve workbenches were evaluated in total. Beyond the five listed above, Spoofax, Rascal, Racket, Neverlang, textX, Chevrotain, and Kotlin+ANTLR+lsp4j were assessed and excluded for reasons including: lack of production-ready VS Code support, abandoned IDE tooling, architectural mismatch (S-expression syntax, projectional editing), or infeasible learning curves for a 15-week timeline.

Key references:

- [TypeFox: Xtext, Langium, what next?](https://www.typefox.io/blog/xtext-langium-what-next/)
- [Langium 4.0 Release](https://www.typefox.io/blog/langium-release-4.0/)
- [Call To Action: Secure the future maintenance of Xtext (GitHub #1721)](https://github.com/eclipse-xtext/xtext/issues/1721)
- [Jordan & Zib: A Langium-based approach to BigER (TU Wien, 2024)](https://model-engineering.info/publications/theses/thesis-jordan-zib.pdf)
