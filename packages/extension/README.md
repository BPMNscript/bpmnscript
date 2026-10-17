# vscode-bpmnscript

The VS Code extension for BPMNscript.
It runs the language server for highlighting, completion, hover, go to definition, references, rename, the outline and inline diagnostics, and it converts the open file between `.bpmnscript` and `.bpmn` from a sidebar panel or the command palette.

The language intelligence lives in `@bpmn-script/language`, and this package loads it into VS Code.
That wiring is mostly Langium scaffold ([ADR-0003](https://github.com/BPMNscript/bpmnscript/blob/main/docs/decisions/0003-use-langium-as-language-workbench.md)).
What is specific to this project is the conversion layer: three commands (`bpmnscript.compile`, `bpmnscript.decompile`, and `bpmnscript.openAndDecompile`, which picks a BPMN file from disk and decompiles it) and a sidebar webview that drives them.

## Installing

```bash
npm run build
npm run package -w packages/extension
code --install-extension packages/extension/vscode-bpmnscript-0.1.0.vsix
```

VS Code then shows the BPMNscript icon in the activity bar and offers `BPMNscript: Compile to BPMN` in the command palette when a `.bpmnscript` file is open.

To try a change to the extension without packaging it, press <kbd>F5</kbd> in VS Code from the repo root.
A second window opens with the extension loaded.

## How it fits together

The extension has three parts in two bundles: the client and the conversion layer in `out/extension/main.cjs`, and the language server in `out/language/main.cjs`.

The client (`src/extension/main.ts`) runs inside VS Code.
It starts the language server when a `.bpmnscript` file opens, registers the conversion commands and the sidebar, and keeps the sidebar in sync with the active editor.

The language server (`src/language/main.ts`) runs in a separate process.
It loads `createBpmnScriptServices` from `@bpmn-script/language` and answers the editor's LSP requests.
Hover shows a step's kind and label, a code's kind and message, a variable's type, and a `/** ... */` comment written before the statement.
Completion offers only what the validator accepts at that position.
Rename edits every site of a step, a code or a variable.

The conversion layer is split along the VS Code boundary.
`conversion-core.ts` has no `vscode` import, so vitest tests it without an editor host.
It runs the compile and decompile pipelines and decides what blocks a conversion: errors do, warnings don't.
A decompile returns the warnings from both `xmlToIr` and `irToDsl` in one list.
`conversion.ts` is the VS Code adapter around it, and it behaves as follows:

- The source is the command's argument, otherwise the active editor, and an unsaved editor's text is used as it stands.
- A file with the wrong extension for the command is refused, and the message names the command that takes it.
- A validation failure opens the Problems panel, where the language server already shows the diagnostics.
- The output goes next to the source with the extension swapped; an existing file is overwritten only after you confirm, and the output opens when written.
- A compile whose diagram can't be drawn still writes the file and shows a warning.
- A BPMN construct the transform refuses shows an error notification with its headline, and nothing is written.
- Warnings show as one notification giving their count.
  Its Show Details button opens the BPMNscript output channel, which holds the full messages with their `note:` and `help:` lines.

`sidebar-view-provider.ts` provides the "Convert" view in the "BPMNscript" activity-bar container.
The webview (`media/sidebar.{html,css,js}`) shows the active file, one convert button, and a link to the counterpart file when it exists on disk.
Its buttons post messages that the provider dispatches to the same commands as the palette, so both behave identically.

## Syntax highlighting

The base TextMate grammar is generated from the `language` package's Langium grammar at build time and copied in, so it always tracks the real grammar.
`packages/language/textmate-postprocess.mjs` adjusts it after generation, so a hyphenated name keeps its color past the first `-`, and numbers and operators get a scope.

A hand-maintained injection grammar (`injection/bpmn-script.injection.tmLanguage.json`) colors the body of a `script` task the way a Markdown fenced code block works.
The opening tag selects the embedded scope (`source.js`, `source.python`, `source.ruby`, `source.groovy`); `feel` and any other accepted tag without an installed grammar stay uncolored.
Inside the fence there is highlighting only, with no completion, hover, or diagnostics.
`build:prepare` copies the injection grammar into `syntaxes/`, and `contributes.grammars` in `package.json` registers it with `injectTo: ["source.bpmn-script"]`.

## Build

```bash
# From repo root
npm run build --workspace packages/extension
```

`esbuild` bundles both entry points into CommonJS under `out/`.
The bundle takes `@bpmn-script/language` and `@bpmn-script/transform` from their compiled `out/` directories, so a source change in either is invisible until you rebuild it, or run `npm run build` from the repo root.

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
| `media/icon.png`                                  | Marketplace/Extensions-view icon, rasterized from `media/sidebar-icon.svg`                                                    |
| `package.json`                                    | Registers the language, commands, menus, sidebar, and activation events                                                       |
| `language-configuration.json`                     | Brackets, comments, auto-closing pairs, and the word pattern                                                                  |
| `esbuild.mjs`                                     | Bundles both entry points; adds the `import.meta.url` CJS shim and copies the moddle asset                                    |
| `injection/bpmn-script.injection.tmLanguage.json` | Injection grammar for embedded-language highlighting inside a `script` body                                                   |
| `syntaxes/`                                       | TextMate grammars, both copied in at build time: the base grammar from `language` and the injection grammar from `injection/` |
| `LICENSE`                                         | Copied from the repo root by `build:prepare`, git-ignored, packed into the vsix                                               |
