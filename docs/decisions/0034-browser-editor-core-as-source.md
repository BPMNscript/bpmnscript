---
status: accepted
date: 2026-11-23
decision-makers: Marlon Kranz
---

# The browser editor core ships as TypeScript source

## Context and Problem Statement

Two sites run a BPMNscript playground on the `@bpmn-script/web` worker ([ADR-0033](0033-browser-package-and-shared-conversion.md)): the author's portfolio and a playground for this repo on GitHub Pages.
Both need the same editor core: Monaco set up for BPMNscript, the language client on the worker, the syntax theme, and the layout fixes for compiled diagrams.
A fix to that core should reach both sites without copying code by hand.
How is the core shared?

## Decision Drivers

- One Monaco and VS Code API instance per page: a second copy loads Monaco twice and starts a second set of VS Code services beside the site's.
- Each site keeps its own UI, framework, styles and colours.
- A site already builds `@bpmn-script/web` from a checkout or tag of this repo, and should get the core from the same source.

## Considered Options

- A prebuilt bundle, like the worker
- A published npm package with compiled JavaScript and Monaco as peer dependencies
- A workspace package that sites copy as TypeScript source

## Decision Outcome

Chosen option: "a workspace package that sites copy as TypeScript source", because each site compiles it with its own bundler against its own Monaco, gets it from the same checkout as the worker, and nothing needs publishing.

`@bpmn-script/editor` holds the source, names the Monaco packages as peer dependencies, and is private.
A site copies `packages/editor/src` next to the worker's other outputs and imports from there.

### Consequences

- Good, because a fix reaches every site on its next build from a newer tag, with no release step of its own.
- Good, because a site's typecheck checks the core against the Monaco versions it installed.
- Neutral, because the repo now installs the Monaco packages as dev dependencies, which also places `@codingame/monaco-vscode-extension-api` at `node_modules/vscode`.
- Bad, because the peer versions are a promise the copy does not check: a site on other Monaco versions finds out from its typecheck.

## Pros and Cons of the Options

### A prebuilt bundle, like the worker

- Good, because a site needs no build setup for it.
- Bad, because the bundle would carry its own Monaco beside the site's.

### A published npm package with compiled JavaScript

- Good, because npm checks the peer versions.
- Bad, because every fix needs a publish and a dependency bump in each site, beside the worker tag the site already follows.
