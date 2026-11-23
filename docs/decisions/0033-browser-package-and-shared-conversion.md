---
status: accepted
date: 2026-11-11
decision-makers: Marlon Kranz
---

# A browser package beside the extension, on a shared conversion core

## Context and Problem Statement

A browser playground should offer what the VS Code extension offers: the real language server, with its completion, hover and diagnostics, and compile and decompile on the same text.
The extension is a VS Code extension and nothing else ([ADR-0004](0004-use-vscode-as-primary-ide-target.md)): its server runs on Node over stdio, its conversion code lived in the extension's own source, and its package is shaped by the VS Code manifest and `vsce`.
Where should the browser entry live, and how do the two front-ends share the conversion code without one depending on the other?

## Decision Drivers

- The extension stays a VS Code extension: no browser build, no second target inside its manifest.
- One conversion core, so a fix to compile or decompile reaches every front-end at once.
- Browser code must not reach a Node API, and that should fail the build, not a user's page.
- The repo already splits one concern per npm workspace ([ADR-0002](0002-use-mono-repo-structure.md)).
- Moving a package costs every path that names it: CI, `.vscode/launch.json`, the docs and the `vsce` setup.

## Considered Options

- A browser entry inside `packages/extension`
- Restructure into `packages/extensions/{vscode,web}`
- A `@bpmn-script/conversion` package for the shared core and a `@bpmn-script/web` package for the browser worker

## Decision Outcome

Chosen option: "`@bpmn-script/conversion` and `@bpmn-script/web`", because it gives each concern its own workspace as the repo already does, lets both front-ends consume the same core rather than each other, and moves nothing that exists.

`@bpmn-script/conversion` holds `compileDslToBpmn` and `decompileBpmnToDsl`, moved out of the extension unchanged, and the extension imports it.
`@bpmn-script/web` builds one ES module web worker that runs the Langium language server over `postMessage` and answers two custom requests on the same connection, `bpmnscript/compile` and `bpmnscript/decompile`, whose results are the conversion package's own `CompileResult` and `DecompileResult`.
Its build also writes the Monarch grammar that Langium generates and the language configuration, so a Monaco front-end needs nothing from the extension.

### Consequences

- Good, because `conversion` and `web` compile with `"types": []`, and `web` with `"lib": ["ES2024", "WebWorker"]`, so the type checker refuses a Node API in either, and esbuild's browser platform fails the bundle on a Node builtin.
- Good, because the Operaton moddle extension is imported statically in `@bpmn-script/transform` rather than read with `node:fs`, which is what lets the transform run in a worker at all, and the extension bundle no longer copies the file beside itself.
- Good, because `language-configuration.json` moves to `packages/language`, where every editor front-end reads it, and the extension copies it in at `build:prepare` as it already does for the TextMate grammar.
- Good, because `packages/extension`, its CI paths, launch configuration and docs stay where they are.
- Neutral, because the worker builds its own language services beside the conversion package's, so it holds the grammar twice in memory.
- Neutral, because the CLI keeps its own compile path, which formats diagnostics for a terminal; folding it into `conversion` is a possible follow-up.
- Bad, because the workspace grows to five packages plus the test workspace, each with its own `package.json` and build step.

## Pros and Cons of the Options

### A browser entry inside `packages/extension`

- Good, because it adds no package.
- Bad, because the VS Code extension would carry a second, unrelated target, and its manifest, bundle and `vsce` setup would have to tell the two apart.
- Bad, because the browser code would sit beside code that uses `vscode` and Node, with nothing that keeps it out.

### Restructure into `packages/extensions/{vscode,web}`

- Good, because the two front-ends sit side by side under one name.
- Bad, because it moves the VS Code package and every path that names it: CI, `.vscode/launch.json`, the docs and the `vsce` setup.
- Bad, because the shared conversion code still needs a home that neither front-end owns.
