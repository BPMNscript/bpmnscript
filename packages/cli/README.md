# bpmns CLI

The `bpmns` command-line binary for compiling and decompiling BPMNscript files.

## In plain terms

This package is the thin glue that wires the other two together for use in a terminal. It owns no transformation logic of its own: it reads a file, hands it to `@bpmn-script/language` (to parse and validate) and `@bpmn-script/transform` (to convert), prints any errors, and writes the result. Most of the code here is argument handling, file I/O, and turning failures into clear messages and exit codes.

Two subcommands, and note the naming: `build` compiles DSL → BPMN, and `parse` goes the other way, decompiling BPMN → DSL.

## Purpose

Provides two subcommands that drive the full DSL ↔ BPMN XML pipeline:

- `bpmns build` — compile a `.bpmnscript` source file to BPMN 2.0 XML (with auto-generated diagram interchange data).
- `bpmns parse` — decompile a `.bpmn` file back to `.bpmnscript` DSL source.

## Usage

```sh
# Compile — output goes to same directory with same basename by default
bpmns build invoice-approval.bpmnscript

# Compile with explicit output path
bpmns build invoice-approval.bpmnscript -o out/invoice-approval.bpmn

# Decompile — output goes to same directory with same basename by default
bpmns parse invoice-approval.bpmn

# Decompile with explicit output path
bpmns parse invoice-approval.bpmn -o invoice-approval.bpmnscript
```

Exit codes: `0` success, `1` validation/parse errors, `2` I/O errors.

## Public API surface

The CLI package is not intended to be imported programmatically. Import `@bpmn-script/transform` directly for the transforms and `@bpmn-script/language` for the Langium services.

## Source layout

| File           | Purpose                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `src/main.ts`  | CLI entry point; registers `build` and `parse` subcommands via `commander`     |
| `src/build.ts` | `buildAction`: parse → validate → `astToIr` → `irToXml` → write `.bpmn`        |
| `src/parse.ts` | `parseAction`: read `.bpmn` → `xmlToIr` → `irToDsl` → write `.bpmnscript`      |
| `src/util.ts`  | Shared helpers: `resolveOutputPath` (output-path derivation) and `CLI_VERSION` |
| `bin/cli.js`   | Thin shell script that calls the compiled entry point                          |

## Build and test

```bash
# From repo root
npm run build --workspace packages/cli
npm test --workspace packages/cli

# From this directory
npm run build
npm test
```

## Dependencies on other packages

- `@bpmn-script/transform` (workspace) — all four transform functions
- `@bpmn-script/language` (workspace) — Langium services for parsing `.bpmnscript` files
