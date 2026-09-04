# vscode-bpmnscript

The VS Code extension for BPMNscript.
It runs the Langium language server for highlighting, autocompletion, hover, and inline diagnostics, and it converts the open file between `.bpmnscript` and `.bpmn` from a sidebar panel or the command palette.

The language intelligence itself lives in `@bpmn-script/language`; this package loads it in VS Code.
That wiring is mostly Langium scaffold, which is the point of choosing Langium in the first place ([ADR-0002](../../docs/decisions/0002-use-langium-as-language-workbench.md)).
The conversion layer on top is project-specific: three commands (`bpmnscript.compile`, `bpmnscript.decompile`, and `bpmnscript.openAndDecompile`, which picks a BPMN file from disk and decompiles it) and a sidebar webview that drives them for the active file.

## How it fits together

Three parts bundle into `out/extension/main.cjs`.

The extension client (`src/extension/main.ts`) runs inside VS Code.
Opening a `.bpmnscript` file starts the language server and connects to it; the client also registers the conversion commands, wires up the sidebar webview provider, and listens for editor changes to keep the sidebar in sync.

The language server (`src/language/main.ts`) runs in a background process.
It imports `createBpmnScriptServices` from `@bpmn-script/language` and answers the editor's LSP requests.

The conversion layer splits along the VS Code boundary.
`conversion-core.ts` is a pure, `vscode`-free module driving the `compileDslToBpmn` and `decompileBpmnToDsl` pipelines, and it holds the decisions: severity gating (warnings don't block a compile), error classification, unsupported-element handling.
A successful decompile also returns `warnings`, what `xmlToIr` reported on the way in and `irToDsl` on the way out, in one list.
Because nothing here touches `vscode`, it's testable under vitest with no editor host.
`conversion.ts` is the adapter around it: it resolves the source URI (an argument, otherwise the active editor), reads the text (preferring an unsaved in-memory document), calls the core, maps validation errors into the Problems panel through a `DiagnosticCollection`, asks before overwriting an existing output file, writes the result next to the source with the extension swapped, and opens it.
A BPMN construct the transform refuses surfaces as an error notification and no file is written; any `warnings` surface as one aggregated notification listing what the two hops reported.

`sidebar-view-provider.ts` implements `WebviewViewProvider` for the "Convert" view in the "BPMNscript" activity-bar container.
The webview (`media/sidebar.{html,css,js}`) posts `{type:'compile'|'decompile'|'open'|'pick', uri}` messages that the provider dispatches to those same commands, so the sidebar and the palette behave identically.
It follows the active editor, showing the current file, one convert button, and a link to the counterpart file when that already exists on disk.
Conversions open their output, so moving between the two files is one click.

## Syntax highlighting

The base TextMate grammar is generated from the `language` package's `.langium` grammar at build time and copied in, so it always tracks the real grammar.

A second, hand-maintained TextMate injection grammar (`injection/bpmn-script.injection.tmLanguage.json`) colors the body of a `script` task the way a markdown fenced code block works: the opening language tag selects the embedded scope (`source.js`, `source.python`, `source.ruby`, `source.groovy`), and `feel` or any other accepted tag without an installed grammar falls back to a plain uncolored block.
This is highlighting only, with no autocomplete, hover, or diagnostics inside the fence.
`build:prepare` copies the injection asset into `syntaxes/` next to the base grammar, and `package.json`'s `contributes.grammars` registers it with `injectTo: ["source.bpmn-script"]`.

## Build and run

```bash
# From repo root
npm run build --workspace packages/extension
```

`esbuild` bundles both entry points into CommonJS under `out/`, which is how VS Code loads extensions.
To try it live, press <kbd>F5</kbd> in VS Code from the repo root: a second window opens with the extension loaded, where `.bpmnscript` and `.bpmn` files get language support and the sidebar panel.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#trying-it-out-in-vs-code).

Build order matters.
The extension bundles `@bpmn-script/language` and `@bpmn-script/transform` from their compiled `out/` directories, so a source edit in either one is invisible until you rebuild it (or run `npm run build` from the repo root).

## Source layout

| Path                                              | Purpose                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/extension/main.ts`                           | Entry point: starts the LSP client, registers the commands and the sidebar                                                    |
| `src/extension/conversion-core.ts`                | Pure conversion core: `compileDslToBpmn`, `decompileBpmnToDsl`, `swapExtension`                                               |
| `src/extension/conversion.ts`                     | VS Code adapter: URI resolution, file I/O, diagnostics, notifications                                                         |
| `src/extension/sidebar-view-provider.ts`          | Webview view provider for the "Convert" panel                                                                                 |
| `src/language/main.ts`                            | Language-server entry point; wires in `@bpmn-script/language`'s services                                                      |
| `media/sidebar.html`                              | Webview HTML (strict CSP with a per-render nonce; no inline scripts or remote sources)                                        |
| `media/sidebar.css`                               | Webview styles built on `--vscode-*` theme variables                                                                          |
| `media/sidebar.js`                                | Webview script: renders state, posts convert and open messages to the extension host                                          |
| `media/sidebar-icon.svg`                          | Activity-bar icon for the "BPMNscript" view container                                                                         |
| `package.json`                                    | Registers the language, commands, menus, sidebar, and activation events                                                       |
| `language-configuration.json`                     | Brackets, comments, and auto-closing pairs                                                                                    |
| `esbuild.mjs`                                     | Bundles both entry points; adds the `import.meta.url` CJS shim and copies the moddle asset                                    |
| `injection/bpmn-script.injection.tmLanguage.json` | Injection grammar for embedded-language highlighting inside a `script` body                                                   |
| `syntaxes/`                                       | TextMate grammars, both copied in at build time: the base grammar from `language` and the injection grammar from `injection/` |
