# bpmns CLI

The `bpmns` command compiles and decompiles BPMNscript files from a terminal.
The subcommand names are easy to get backwards: `build` compiles BPMNscript to BPMN, and `parse` goes the other way.

This package holds no transformation logic.
It reads a file, hands it to `@bpmn-script/language` to parse and validate and to `@bpmn-script/transform` to convert, prints what went wrong, and writes the result.
It is not meant to be imported; use those two packages directly.

## Usage

```sh
# Compile; the output lands next to the source under the same basename
bpmns build invoice-approval.bpmnscript

# Compile to a path you pick
bpmns build invoice-approval.bpmnscript -o out/invoice-approval.bpmn

# Decompile; same default output rule
bpmns parse invoice-approval.bpmn

# Decompile to a path you pick
bpmns parse invoice-approval.bpmn -o invoice-approval.bpmnscript
```

From a clone of the repo, run it as `npx bpmns` after `npm run build`.

`build` writes BPMN 2.0 XML with a generated diagram.
When the layout library can't place the graph, `build` writes the document without a diagram, prints `Warning: no diagram could be drawn for this process` with notes naming the cause, and still exits `0`, since Operaton deploys such a file unchanged.

`parse` writes `.bpmnscript` source and then prints two kinds of warning: what the import dropped or changed, and what the printer couldn't carry into the script.
Some of these bear on what a rebuilt document runs, so read them before running `build` on the output.
`parse` then builds the script it just wrote and lists every error `build` would report, still exiting `0`.
The import and print rules behind those warnings are in [packages/transform/README.md](../transform/README.md#the-import-contract).

## Exit codes

| Code | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | Success, with or without warnings                                                                  |
| `1`  | Validation errors or no process on `build`, a BPMN construct the language can't express on `parse` |
| `2`  | A file or path problem, or input that can't be read as BPMN XML                                    |
| `3`  | An unexpected exception inside a transform, which is a bug in `bpmns`                              |

A command that exits `1` writes nothing.
Every message opens with a headline naming what is wrong and where, with its `note:` and `help:` lines indented beneath it.

## Files and paths

- Both subcommands read a file from disk, never stdin.
- `build` takes only a `.bpmnscript` file; `parse` takes any file that reads as BPMN XML.
- An existing output file is left alone unless you pass `--force`.
- An `-o` naming the input file itself always exits `2`, even with `--force`.
- An `-o` naming an existing directory writes into it under the input's basename.

## Build and test

```bash
# From repo root
npm run build --workspace packages/cli
npm test --workspace packages/cli

# From this directory
npm run build
npm test
```

## Source layout

| File           | Purpose                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `src/main.ts`  | Entry point; registers `build` and `parse` through `commander`         |
| `src/build.ts` | `buildAction`: parse, validate, `astToIr`, `irToXml`, write `.bpmn`    |
| `src/parse.ts` | `parseAction`: read `.bpmn`, `xmlToIr`, `irToDsl`, write `.bpmnscript` |
| `src/util.ts`  | Shared by both actions: path guards, `buildDocument`, `CLI_VERSION`    |
| `bin/cli.js`   | Node entry script; imports the compiled `out/main.js` and runs it      |
