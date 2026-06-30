---
status: accepted
date: 2026-06-28
decision-makers: Marlon Kranz
---

# In-Editor Conversion: Webview Sidebar, Two-Layer Architecture, and CJS Bundling

## Context and Problem Statement

The only way to compile `.bpmnscript` → `.bpmn` or decompile `.bpmn` → `.bpmnscript` was
the `bpmns` CLI. The CLI entry points (`buildAction`/`parseAction`) bake in `process.exit()`
and `console.log`, making them unusable inside the VS Code extension host.

Three related questions arose:

1. **UI:** What surface should the in-editor conversion use — a native VS Code tree view or a
   webview panel in a dedicated activity-bar container?
2. **Architecture:** How should the conversion logic be structured so it can be tested without
   the VS Code host, which is unavailable under plain vitest?
3. **Bundling:** `@bpmn-script/transform` calls `fileURLToPath(import.meta.url)` at
   module-init time to locate `operaton-moddle.json`. esbuild's CJS output sets
   `import.meta.url` to `undefined`, causing `ERR_INVALID_ARG_TYPE` on extension activation
   — the same JSON-asset footgun seen in `packages/transform/src/`. How should it be resolved
   for the bundled extension?

## Decision Drivers

* Conversion must produce the same result whether invoked from the sidebar or the command
  palette — a single execution path is preferable to separate implementations
* The conversion pipeline logic must be unit-testable without a VS Code host; the extension
  host's `vscode` module is not importable under vitest
* `operaton-moddle.json` resolution must be verified against the **bundled** extension, not
  just source — a successful `npm run build` does not guarantee activation if the asset path
  is wrong at runtime
* The sidebar should track the VS Code theme automatically, with no external UI toolkit

## Considered Options

### UI approach

* Native VS Code tree view (`TreeDataProvider`) with command-keyed rows
* Webview panel (`WebviewViewProvider`) in a dedicated activity-bar container

### Bundling fix

* Copy `operaton-moddle.json` to `out/extension/` and add a multi-candidate resolver fallback
  in the transform package to look there if the primary path fails
* Add an esbuild `import.meta.url` CJS shim + copy the asset beside the bundle via an
  `onEnd` plugin, keeping the transform package unmodified

## Decision Outcome

**UI:** webview panel in a dedicated "BPMNscript" activity-bar container (view id
`bpmnscript.sidebar`, name "Convert"). The panel renders a small custom layout for the active
file — its name, one convert button, a link to the counterpart file when it exists, and a
"pick a BPMN file" action — using only `--vscode-*` CSS custom properties, so it tracks the
host theme without any external toolkit dependency. A webview gives direct control over that
layout and leaves room to grow it (for example, an inline diagram preview) in a way a tree
view's fixed row model would not.

**Architecture:** two-layer split — a pure core (`conversion-core.ts`, no `vscode` import)
and a thin VS Code adapter (`conversion.ts`). The core contains all interesting logic
(severity gating, error classification, unsupported-element handling) and is unit-testable
under vitest. The adapter owns only VS Code I/O: URI resolution, file reads and writes,
`DiagnosticCollection` updates, overwrite confirmation, and opening the result. The commands
(`bpmnscript.compile`, `bpmnscript.decompile`, and `bpmnscript.openAndDecompile`, which picks
a BPMN file and runs the decompile handler on it) are the single execution path; the sidebar
and the command palette call the same commands with a URI argument, so behaviour is identical
across entry points.

**Bundling:** esbuild CJS shim + `onEnd` asset copy, keeping the transform package
unmodified. In `esbuild.mjs`:

```js
define: { 'import.meta.url': 'importMetaUrl' },
banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
```

This makes `import.meta.url` resolve to the bundle file (`out/extension/main.cjs`), so
`dirname(fileURLToPath(import.meta.url))` equals `out/extension/`. An `onEnd` plugin copies
`packages/transform/src/operaton-moddle.json` to `out/extension/operaton-moddle.json` on
every build, including `--watch` rebuilds. The `sharedBuildOptions` and `assetCopyPlugin`
are exported from `esbuild.mjs` so the E2E test suite bundles a verify entry with the
identical configuration — asserting the bundled conversion resolves the real copied asset at
runtime, not just that the build succeeds.

### Consequences

* Good, because the sidebar and the command palette reach the same code path — one
  implementation to test and maintain
* Good, because the pure conversion core is fully covered by vitest integration tests without
  any VS Code host setup
* Good, because the bundled-runtime E2E test (`test/bundled-conversion.e2e.test.ts`) provides
  an automated, reproducible check for the `import.meta.url` / asset-resolution risk — no
  manual activation step is needed
* Good, because the webview tracks VS Code themes with zero external UI dependencies
* Neutral, because the esbuild shim is a build-time coupling: if esbuild's CJS handling
  changes the `import.meta.url` semantics, the shim must be revisited
* Neutral, because the webview approach adds `media/sidebar.{html,css,js}` files that the
  native-tree-view path would not require

### Confirmation

The `test/bundled-conversion.e2e.test.ts` suite bundles a small verify entry with the same
esbuild options and asserts that `xmlToIr`/`irToXml` complete successfully under Node,
proving `operaton-moddle.json` resolved from the bundle's output directory. The
`test/conversion-core.test.ts` suite asserts severity gating, error classification, and the
round-trip at the pure-core level.
