# vscode-bpmnscript

The VS Code extension for BPMNscript. It bundles the Langium language server so that opening a `.bpmnscript` file in VS Code gives you syntax highlighting, autocompletion, and inline error diagnostics.

## In plain terms

This is the delivery vehicle, not where the language logic lives. The actual smarts — grammar, parser, validator — are in `@bpmn-script/language`; this package just packages them as a VS Code extension and tells the editor how to load them.

It's almost entirely generated scaffold from Langium's project template, and that's by design: choosing Langium ([ADR-0002](../../docs/decisions/0002-use-langium-as-language-workbench.md)) is precisely what makes the editor integration come for free. The only project-specific lines are the language registration in `package.json` (the `bpmn-script` id, the `.bpmnscript` extension, where to find the highlighting grammar) and a single `import { createBpmnScriptServices }` that plugs our language into the generic server.

## How it fits together

A VS Code language extension has two halves, and both live here:

- **The extension client** (`src/extension/main.ts`) runs inside VS Code. When you open a `.bpmnscript` file it starts the language server in a background process and connects to it.
- **The language server** (`src/language/main.ts`) is that background process. It imports `createBpmnScriptServices` from `@bpmn-script/language` and answers the editor's requests — "what's valid here?", "any errors?", "what can I autocomplete?" — over the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

The syntax-highlighting grammar (a TextMate file) isn't written by hand either. Langium generates it from the same `.langium` grammar in the `language` package, and this package's `build:prepare` step copies it in. So highlighting always matches the real grammar.

## Build and run

```bash
# From repo root
npm run build --workspace packages/extension
```

`esbuild` bundles both halves into CommonJS files under `out/` (VS Code loads extensions as CommonJS). To try the extension live, press <kbd>F5</kbd> in VS Code from the repo root — it opens a second window with the extension loaded, where `.bpmnscript` files light up. See [CONTRIBUTING.md](../../CONTRIBUTING.md#trying-it-out-in-vs-code).

## Source layout

| Path                          | Purpose                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/extension/main.ts`       | Extension entry point; starts and connects to the language server           |
| `src/language/main.ts`        | Language-server entry point; wires in `@bpmn-script/language`'s services    |
| `package.json`                | Registers the `bpmn-script` language, `.bpmnscript` extension, and grammar  |
| `language-configuration.json` | Brackets, comments, and auto-closing pairs for the editor                   |
| `esbuild.mjs`                 | Bundles both entry points to CommonJS                                       |
| `syntaxes/`                   | TextMate highlighting grammar (copied from the `language` package at build) |
