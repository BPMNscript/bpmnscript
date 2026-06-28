# Contributing to BPMNscript

> This project is being developed as part of a bachelor's thesis.
> External contributions are not accepted until after thesis submission.
> The guidelines below will apply once the project opens up.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22 (the project uses Node 24 via `.nvmrc`; [nvm](https://github.com/nvm-sh/nvm) picks this up automatically)
- [VS Code](https://code.visualstudio.com/) with the recommended extensions (VS Code will prompt you on first open)
- [Docker](https://www.docker.com/) for end-to-end tests (alternatives: [Podman](https://podman.io/), [Rancher Desktop](https://rancherdesktop.io/))

### Getting started

```sh
git clone https://github.com/BPMNscript/bpmnscript.git
cd bpmnscript
npm install
npm run build
npm test
```

`npm run build` runs the Langium code generator and compiles TypeScript across all packages. `npm test` runs the full test suite including Docker-based end-to-end tests. To skip those (no Docker installed, or just iterating on unit tests):

```sh
SKIP_DOCKER_TESTS=true npm test
```

### Trying it out in VS Code

After building, press <kbd>F5</kbd> in VS Code. This opens a second VS Code window with the BPMNscript extension loaded. In that window you can create or open `.bpmnscript` files and get syntax highlighting, inline diagnostics, and autocompletion. To compile or decompile a file, use the command palette (`BPMNscript: Compile to BPMN` / `BPMNscript: Decompile to BPMNscript`), the editor title bar button, the explorer context menu, or the "Convert" panel in the BPMNscript activity-bar sidebar. The CLI alternative (`npx bpmns build <file>`) still works if you prefer the terminal.

### Editing the grammar

The Langium grammar lives at `packages/language/src/bpmn-script.langium`. After editing it, regenerate the AST types before TypeScript can see the changes:

```sh
npm run langium:generate
```

For continuous regeneration while editing:

```sh
npm run langium:watch
```

Both commands run from the repo root.

### Running tests

```sh
npm test                                   # Full suite (all packages + e2e)
npm test --workspace packages/language     # Language package only
npm test --workspace packages/transform    # Transform package only
npm test --workspace packages/cli          # CLI package only
npm test --workspace packages/extension    # Extension package only
```

The extension tests require `@bpmn-script/language` and `@bpmn-script/transform` to be built first (they are consumed as compiled `out/` directories). Run `npm run build` from the repo root before running the extension suite in isolation.

### Code style

The project uses [Prettier](https://prettier.io/) for formatting and [ESLint](https://eslint.org/) (via `eslint-plugin-bpmn-io`) for linting. Both run from the repo root:

```sh
npm run format         # Auto-format all source files
npm run format:check   # Check formatting without writing (used in CI)
npm run lint           # Run ESLint
```

Formatting happens on save if you use VS Code with the recommended Prettier extension. The `.editorconfig` handles basics (indentation, line endings) for other editors.

## Guidelines (post-thesis)

### Reporting bugs

Use the [bug report template](https://github.com/BPMNscript/bpmnscript/issues/new?template=bug_report.yml).

### Suggesting features

Use the [feature request template](https://github.com/BPMNscript/bpmnscript/issues/new?template=feature_request.yml).

### Pull requests

- Reference the related issue with `Closes #...`
- Include a brief description of what changed and why
- Make sure `npm test`, `npm run lint`, and `npm run format:check` all pass
- Update `CHANGELOG.md` if the change is user-facing

### Architectural decisions

Non-trivial technical decisions are documented as [Markdown ADRs](docs/decisions/) using [MADR 4.0.0](https://adr.github.io/madr/). If your change involves an architectural decision, include a new ADR.
