# @bpmn-script/web

The BPMNscript language server and its compile and decompile in one browser web worker, with no Node APIs.

## What the worker offers

The worker speaks JSON-RPC over `postMessage`, using `BrowserMessageReader` and `BrowserMessageWriter` from `vscode-languageserver/browser`.
It is an ES module worker, so create it with `{ type: "module" }`.

- Everything Langium's language server provides: completion, hover, diagnostics (`textDocument/publishDiagnostics`), semantic tokens, signature help and code actions.
- `bpmnscript/compile`, params `{ source: string }`, result:
  `{ ok: true; output: string; layoutWarning?: string } | { ok: false; kind: "validation"; diagnostics: ConvDiagnostic[] } | { ok: false; kind: "error"; message: string }`
- `bpmnscript/decompile`, params `{ xml: string }`, result:
  `{ ok: true; output: string; warnings: { elementId: string; category: string; message: string }[]; buildErrors: ConvDiagnostic[] } | { ok: false; kind: "unsupported"; message: string } | { ok: false; kind: "error"; message: string }`
- `ConvDiagnostic` is `{ line, character, endLine, endCharacter: number; message: string; severity: 1 | 2; text: string }`, with 0-based positions.

Both requests work any time after `initialize` and never answer with a JSON-RPC error: a failure is an `{ ok: false, kind: "error" }` result.
The compiled XML carries this package's version as `exporterVersion`.
Messages are the compiler's own English text: a headline line, then `note: ` and `help: ` lines.

## Building

From the repo root, after `npm ci`:

```sh
npm run build:web
```

This writes `packages/web/out/`:

| File                          | Contents                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `server-worker.js`            | The worker, one minified ES module                                         |
| `monarch.js`                  | ES module whose default export is the Monarch grammar for Monaco           |
| `language-configuration.json` | Comments, brackets, auto-closing pairs and word pattern, as plain JSON     |
| `LICENSE`                     | The BPMNscript license                                                     |
| `operaton-moddle.LICENSE`     | The license of the Operaton moddle extension that is bundled in the worker |

`npm run build` builds it too.

## Usage

```ts
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser';

const worker = new Worker('/server-worker.js', { type: 'module' });
const connection = createMessageConnection(
  new BrowserMessageReader(worker),
  new BrowserMessageWriter(worker),
);
connection.listen();

await connection.sendRequest('initialize', {
  processId: null,
  rootUri: null,
  capabilities: {},
});
connection.sendNotification('initialized', {});

const result = await connection.sendRequest<{ ok: boolean; output?: string }>(
  'bpmnscript/compile',
  {
    source: 'process p {\n  start s\n  end e\n}\n',
  },
);
if (result.ok) console.log(result.output);
```

A full editor connects a language client (for example `monaco-languageclient`) to the same worker instead of a bare connection; the two custom requests go through the client's `sendRequest`.
