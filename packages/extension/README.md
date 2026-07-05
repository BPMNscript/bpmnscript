# vscode-bpmnscript

The VS Code extension for BPMNscript. It bundles the Langium language server for syntax highlighting, autocompletion, and inline error diagnostics. It also converts the open file between `.bpmnscript` and `.bpmn` from a sidebar "Convert" panel — which also jumps to a file's counterpart and lets you pick a `.bpmn` from disk to decompile — and from the command palette.

## In plain terms

The language intelligence — grammar, parser, validator — lives in `@bpmn-script/language`; this package loads it in VS Code as a language server. On top of that scaffold it adds the conversion layer: three commands (`bpmnscript.compile`, `bpmnscript.decompile`, and `bpmnscript.openAndDecompile`, which picks a BPMN file and decompiles it) and a small sidebar webview that drives them for the active file.

The language server wiring is almost entirely Langium scaffold, and that's by design: choosing Langium ([ADR-0002](../../docs/decisions/0002-use-langium-as-language-workbench.md)) is what makes the editor integration come for free. The conversion layer is project-specific.

## How it fits together

The extension has three parts, all bundled into `out/extension/main.cjs`:

- **The extension client** (`src/extension/main.ts`) runs inside VS Code. When a `.bpmnscript` file opens it starts the language server and connects to it; it also registers the conversion commands, wires up the sidebar webview provider, and installs an active-editor listener that keeps the sidebar in sync.
- **The language server** (`src/language/main.ts`) runs in a background process. It imports `createBpmnScriptServices` from `@bpmn-script/language` and answers the editor's LSP requests — diagnostics, autocompletion, hover.
- **The conversion layer** converts open files without leaving the editor:
  - `conversion-core.ts` — a pure, `vscode`-free module that drives the full `compileDslToBpmn` and `decompileBpmnToDsl` pipelines. All interesting logic lives here: severity gating (warnings do not block compilation), error classification, unsupported-element handling. `decompileBpmnToDsl`'s success result also carries `warnings` — non-semantic content (extra Operaton extension attributes, lanes) that `@bpmn-script/transform`'s `xmlToIr` dropped instead of importing silently. Unit-testable under vitest with no VS Code host required.
  - `conversion.ts` — the thin VS Code adapter. Resolves the source URI (passed argument → active editor), reads text (preferring unsaved in-memory documents), calls the core, maps validation errors into the Problems panel via a `DiagnosticCollection`, confirms before overwriting an existing output file, writes the result next to the source (same directory, extension swapped), and opens it. On decompile, a BPMN construct the transform cannot import at all surfaces as an error notification instead of writing a file; non-empty `warnings` surface as one aggregated warning notification listing the dropped items.
  - `sidebar-view-provider.ts` — implements `WebviewViewProvider` for the "Convert" view in the "BPMNscript" activity-bar container. The webview (`media/sidebar.{html,css,js}`) posts `{type:'compile'|'decompile'|'open'|'pick', uri}` messages; the provider dispatches them to the same commands, so the sidebar and the command palette behave identically.

The sidebar updates when you switch editors. It shows the active file, one convert button, and — when the other format already exists on disk — a link to open that counterpart. After a conversion the output opens, so jumping between the two files is just a click.

The TextMate highlighting grammar is generated from the `language` package's `.langium` grammar at build time and copied in; it always tracks the real grammar.

## Build and run

```bash
# From repo root
npm run build --workspace packages/extension
```

`esbuild` bundles both entry points into CommonJS under `out/` (VS Code loads extensions as CommonJS). To try the extension live, press <kbd>F5</kbd> in VS Code from the repo root — it opens a second window with the extension loaded, where `.bpmnscript` and `.bpmn` files get language support and the sidebar panel. See [CONTRIBUTING.md](../../CONTRIBUTING.md#trying-it-out-in-vs-code).

**Build order:** the extension bundles `@bpmn-script/language` and `@bpmn-script/transform` via their compiled `out/` directories. Rebuild those packages (or run `npm run build` from the repo root) before building or testing the extension; a source edit in either package is invisible until rebuilt.

## Source layout

| Path                                     | Purpose                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension/main.ts`                  | Extension entry point: starts the LSP client, registers commands and the sidebar                                                                                                          |
| `src/extension/conversion-core.ts`       | Pure conversion core: `compileDslToBpmn`, `decompileBpmnToDsl`, `swapExtension`                                                                                                           |
| `src/extension/conversion.ts`            | VS Code adapter: URI resolution, file I/O, diagnostics, notifications                                                                                                                     |
| `src/extension/sidebar-view-provider.ts` | Webview view provider for the "Convert" sidebar panel                                                                                                                                     |
| `src/language/main.ts`                   | Language-server entry point; wires in `@bpmn-script/language`'s services                                                                                                                  |
| `media/sidebar.html`                     | Webview HTML (strict CSP with per-render nonce; no inline scripts or remote sources)                                                                                                      |
| `media/sidebar.css`                      | Webview styles using `--vscode-*` theme variables                                                                                                                                         |
| `media/sidebar.js`                       | Webview script: renders state, posts convert/open messages to the extension host                                                                                                          |
| `media/sidebar-icon.svg`                 | Activity-bar icon for the "BPMNscript" view container                                                                                                                                     |
| `package.json`                           | Registers the language, commands, menus, sidebar, and activation events                                                                                                                   |
| `language-configuration.json`            | Brackets, comments, and auto-closing pairs                                                                                                                                                |
| `esbuild.mjs`                            | Bundles both entry points; adds `import.meta.url` CJS shim and copies the moddle asset                                                                                                    |
| `syntaxes/`                              | TextMate grammar (copied from `language` at build)                                                                                                                                        |
| `test/conversion-core.test.ts`           | Integration tests for the pure conversion core (no `vscode` host required)                                                                                                                |
| `test/conversion.test.ts`                | Unit tests for the VS Code adapter (`conversion.ts`), with `vscode` mocked: notification wording (each notification names the file exactly once), aggregated import-warning notifications |
| `test/bundled-conversion.e2e.test.ts`    | E2E test: confirms a bundled conversion resolves `operaton-moddle.json` at runtime                                                                                                        |
