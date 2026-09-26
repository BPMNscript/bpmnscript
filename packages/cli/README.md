# bpmns CLI

The `bpmns` binary, for compiling and decompiling BPMNscript files from a terminal.

This package holds no transformation logic.
It reads a file, hands it to `@bpmn-script/language` to parse and validate and to `@bpmn-script/transform` to convert, prints whatever went wrong, and writes the result.
What's left is argument handling, file I/O, and turning failures into readable messages and exit codes.

The two subcommand names are easy to get backwards: `build` compiles DSL to BPMN, `parse` goes the other way.

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

`build` writes BPMN 2.0 XML with generated diagram interchange data.
When the layout library cannot place the graph, `build` writes the document without diagram data instead, prints `Warning: no diagram could be drawn for this process (...); the file deploys but opens without shapes in a modeler` to stderr, and still exits `0`, since Operaton deploys such a file unchanged (`BpmnParse.parseDiagramInterchangeElements` reads a diagram only when one is present).
`parse` writes `.bpmnscript` source.

Exit codes are `0` for success, `1` for validation errors on `build` or a refused BPMN construct on `parse`, and `2` for an I/O problem or input that cannot be read as BPMN XML.
Both directions report non-fatal warnings on stderr without changing the exit code, so an undeclared variable reference on compile, or a dropped Operaton extension attribute or lane on import, is warned about but still produces a file.
`parse` reports what the print hop could not carry into the script as well: some of those warnings bear on what a recompiled document runs, and some on whether the script builds back at all, so read them before running `build` on the output.
After those warnings, `parse` also re-validates the script it just wrote and reports every error `build` would draw from it, still exiting `0` and still writing the file.
The roundtripping section of the root [README](../../README.md#roundtripping-bpmn-xml---bpmnscript) walks through both hops.
A BPMN construct the DSL cannot express is the exception: `parse` exits `1` with a message naming the construct and writes nothing.

Both subcommands read a file from disk; neither one reads stdin.
An `-o` equal to the input path always exits `2` before anything is touched, `--force` included: there is no output left to write to once it's the same file as the source.
An existing output file at a different path is left alone unless you pass `--force`; without it, the command exits `2` instead of overwriting it.
An `-o` that names an existing directory writes into it under the input's own basename.
`build` refuses a file that is not `.bpmnscript` with exit `2` and a source with no process with exit `1`; `parse` refuses a file it cannot read as BPMN XML, an empty or non-XML one included, with exit `2`.

The package is not meant to be imported programmatically.
Import `@bpmn-script/transform` for the transforms and `@bpmn-script/language` for the Langium services.

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

## Dependencies on other packages

- `@bpmn-script/transform` (workspace) for all four transform functions
- `@bpmn-script/language` (workspace) for the Langium services that parse `.bpmnscript`
