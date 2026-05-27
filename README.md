# BPMNscript

A textual domain-specific language for authoring BPMN 2.0 processes, with IDE support through VS Code.

BPMNscript is being developed as part of a bachelor's thesis at [University of Hamburg](https://www.uni-hamburg.de/), supervised by Dr. Oliver Kopp. The thesis investigates whether a text-based DSL can serve as a practical alternative to graphical BPMN editors for developers who prefer working in code. The language targets the [Operaton](https://operaton.org/) process engine.

## What it does

- Compiles `.bpmnscript` source files to BPMN 2.0 XML with auto-generated diagram layout, ready for deployment to Operaton.
- Decompiles BPMN 2.0 XML back to `.bpmnscript` source.
- Provides syntax highlighting and inline error diagnostics in VS Code.
- Validates structural constraints at authoring time: missing start/end events, orphan nodes, unresolved references.

The DSL currently covers start events, end events, user tasks, service tasks, exclusive gateways, and sequence flows with conditions.

## Quick start

```sh
npm install
npm run build
npm test
```

`npm test` includes Docker-based end-to-end tests that boot an Operaton engine via [testcontainers](https://testcontainers.com/). These require a running Docker daemon. To skip them, set `SKIP_DOCKER_TESTS=true` (CI does this automatically).

## CLI usage

After building, run the CLI with `npx`:

```sh
# Compile .bpmnscript to BPMN 2.0 XML
npx bpmns build examples/spring-boot/processes/invoice-approval.bpmnscript

# With explicit output path
npx bpmns build invoice-approval.bpmnscript -o out/invoice-approval.bpmn

# Decompile BPMN XML back to DSL
npx bpmns parse invoice-approval.bpmn -o invoice-approval.bpmnscript
```

Exit codes: `0` success, `1` validation/parse errors, `2` I/O errors.

## Architecture

The transformation pipeline routes everything through an engine-agnostic intermediate representation (IR). See [ADR-0006](docs/decisions/0006-engine-agnostic-intermediate-representation.md) for the rationale.

```text
.bpmnscript  ->  AST  ->  IR  ->  BPMN XML  ->  .bpmn
.bpmn        ->  IR   ->  .bpmnscript
```

The IR is vendor-neutral. Operaton-specific attributes (`operaton:class`, `operaton:assignee`, etc.) are applied at serialization time through a local [moddle extension](packages/transform/src/operaton-moddle.json).

| Library                                                         | Role                                                |
| --------------------------------------------------------------- | --------------------------------------------------- |
| [Langium](https://langium.org/)                                 | Grammar, parser, AST, LSP server, VS Code extension |
| [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle)           | BPMN 2.0 XML reading and writing                    |
| [bpmn-auto-layout](https://github.com/bpmn-io/bpmn-auto-layout) | Generates diagram layout data on export             |

## Repository structure

```text
packages/
  language/      Langium grammar, AST, validator, language server
  transform/     IR types and bidirectional transforms (AST/IR/XML/DSL)
  cli/           bpmns build / parse commands
  extension/     VS Code extension (bundles the language server)
tests/           Round-trip, fixture, and end-to-end tests
examples/
  spring-boot/   Operaton + Spring Boot Docker fixture for e2e testing
```

See [examples/spring-boot/README.md](examples/spring-boot/README.md) for instructions on running the Operaton fixture.

## Architectural decisions

Design decisions are documented as [Markdown ADRs](docs/decisions/) using [MADR 4.0.0](https://adr.github.io/madr/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
