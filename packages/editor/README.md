# @bpmn-script/editor

The browser editor core every BPMNscript playground shares: Monaco set up for BPMNscript, the language client on the [`@bpmn-script/web`](../web/README.md) worker, the syntax theme, and helpers for showing compiled diagrams in bpmn-js.
It holds no UI and no framework code, so each site builds its own page around it.

## How a site consumes it

The package is TypeScript source, not a bundle.
A site copies `src/` into its own tree, from the same checkout or tag it builds `@bpmn-script/web` from, and its bundler compiles it with the rest of the site.
That way the site's bundle holds one Monaco and one VS Code API instance, its own, and a fix here reaches every site on its next build.

- Imports between the files are extensionless, as a bundler resolves them (`moduleResolution: "bundler"`).
- The Monaco packages are peer dependencies: the site installs `@codingame/monaco-vscode-api`, `@codingame/monaco-vscode-editor-api`, `monaco-languageclient` and `vscode-languageclient` in the versions `package.json` names.
- `monaco.ts` and `client.ts` load Monaco and run only in the browser. The other files are plain functions with no imports at runtime, so server code can use them (`share.ts` in a server-rendered link, for example).

## Files

| File          | Contents                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `monaco.ts`   | `ensureMonacoApi`, `registerBpmnscriptLanguage`, `followMonacoTheme`, `createBpmnscriptEditor`, `openBpmnscriptModel`, `modelDiagnostics`   |
| `client.ts`   | `createBpmnscriptClient`: the worker and a `MonacoLanguageClient` on it, with `compile`, `decompile`, status, restart and request timeouts  |
| `protocol.ts` | The worker's custom requests and their result types, mirroring `@bpmn-script/conversion`                                                    |
| `language.ts` | `LANGUAGE_ID`, `modelUri`, `toLanguageConfiguration`, and the compile shortcut (`COMPILE_SHORTCUT`, `isCompileShortcut`)                    |
| `theme.ts`    | `THEME_TOKENS` and `themeData`, the Monaco theme built from a site's colours                                                                |
| `outcome.ts`  | `compileView`, `importView`, `exportName`: what a compile or import result means for the page                                               |
| `share.ts`    | `encodeShare`, `decodeShare`: a source in a URL hash, `src=` plus base64url of deflate-raw                                                  |
| `diagram.ts`  | `fitViewbox`, and `fixLayout` with its parts: spread boundary events, flows routed outside the sub-process they enter, flow and task labels |
| `presets.ts`  | `PRESETS`: the examples a playground offers, as paths in this repo                                                                          |

## Contract

What a site provides, and what it gets:

- **Workers.** Serve `server-worker.js` (from `npm run build:web`) and Monaco's editor worker (`@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js`, bundled as an ES module) from the site's own origin, and pass their URLs as `workerUrl` and `editorWorkerUrl`.
  The editor worker is created directly, not through a `blob:` URL, so a CSP without `worker-src blob:` allows it.
- **Grammar.** Pass `monarch.js` and `language-configuration.json` from the same web build to `registerBpmnscriptLanguage`.
- **Colours.** Set each of `THEME_TOKENS` as a CSS custom property on the editor's root element, `--pg-bg`, `--pg-panel`, ..., `--pg-syn-name` by default (`followMonacoTheme(root, prefix)` takes another prefix).
  Any CSS colour works, and the theme turns it into hex.
  The theme is dark while `<html>` has the class `dark`, and it follows changes to that class.
- **Model names.** `openBpmnscriptModel(name, text)` keys a model by `file:///playground/<name>`; peek titles show the name alone.
- **Compile key.** `isCompileShortcut(event)` is Ctrl+Enter, or Cmd+Enter on a Mac; the site binds it where it handles its own keys.
- **Presets.** Copy each `PRESETS[].path` from the same checkout and serve it; the site names the examples itself.

## Example

```ts
import monarch from './generated/monarch.js';
import languageConfiguration from './generated/language-configuration.json';
import { createBpmnscriptClient } from './editor/client';
import {
  createBpmnscriptEditor,
  ensureMonacoApi,
  followMonacoTheme,
  openBpmnscriptModel,
  registerBpmnscriptLanguage,
} from './editor/monaco';

const editorWorkerUrl = '/editor.worker.js';
const client = createBpmnscriptClient({
  workerUrl: '/server-worker.js',
  editorWorkerUrl,
});

await ensureMonacoApi({ editorWorkerUrl });
registerBpmnscriptLanguage({ monarch, languageConfiguration });
const root = document.querySelector('#playground')!;
followMonacoTheme(root);
const editor = await createBpmnscriptEditor(root.querySelector('.host')!, {
  ariaLabel: 'Source',
  fontFamily: 'monospace',
});
const { model } = await openBpmnscriptModel(
  'order.bpmnscript',
  'process order {\n  start s\n  end e\n}\n',
);
editor.setModel(model);

const result = await client.compile(model.getValue());
if (result.ok) console.log(result.output);
```

## Testing

```sh
npm test --workspace packages/editor
npm run typecheck --workspace packages/editor
```

The tests cover the plain functions, and the typecheck covers `monaco.ts` and `client.ts` against the peer versions.
Driving Monaco itself needs a browser, so a site's own end-to-end tests cover the editor running.
