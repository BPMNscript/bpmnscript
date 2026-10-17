# Contributing to BPMNscript

> This project is being developed as part of a bachelor's thesis.
> Bug reports are welcome now.
> Pull requests are accepted after the thesis is submitted, and the guidelines below apply from then on.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer (`.nvmrc` pins Node 24, and `nvm use` reads it)
- [VS Code](https://code.visualstudio.com/) with the recommended extensions, which VS Code offers on first open
- [Docker](https://www.docker.com/) for the end-to-end tests ([Podman](https://podman.io/) or [Rancher Desktop](https://rancherdesktop.io/) work too)

### Getting started

```sh
git clone https://github.com/BPMNscript/bpmnscript.git
cd bpmnscript
npm install
npm run build
npm test
```

`npm run build` runs the Langium code generator, compiles TypeScript across all packages, and bundles the extension.
`npm test` runs the full suite, including end-to-end tests that deploy to an Operaton engine in Docker.
To skip those, for example without Docker or while iterating on unit tests:

```sh
SKIP_DOCKER_TESTS=true npm test
```

### Trying it out in VS Code

After building, press <kbd>F5</kbd> in VS Code.
A second window opens with the extension loaded, where you can open `.bpmnscript` files and convert them from the command palette or the Convert panel in the BPMNscript sidebar.
[packages/extension/README.md](packages/extension/README.md) describes what the extension does and how to install it.

### Editing the grammar

The Langium grammar is `packages/language/src/bpmn-script.langium`.
After editing it, regenerate the AST types from the repo root so TypeScript sees the change:

```sh
npm run langium:generate   # once
npm run langium:watch      # on every save
```

The generated code lands in `src/generated/`, which is git-ignored, so there is nothing to commit.
CI runs `git diff --exit-code` after `npm run build` and fails if the build changed any tracked file.

### Running tests

```sh
npm test                                                                     # Full suite (all packages + e2e)
npm test --workspace packages/language                                       # Language package only
npm test --workspace packages/transform                                      # Transform package only
npm test --workspace packages/cli                                            # CLI package only
npm test --workspace packages/extension                                      # Extension package only
FUZZ_N=2000 FUZZ_OUT=/tmp/fuzz npm test --workspace tests -- fuzz.test.ts    # Round-trip fuzz over 2000 generated programs
```

`npm test` includes the round-trip fuzz over the first 200 generated programs.
The extension tests use the compiled `out/` directories of `@bpmn-script/language` and `@bpmn-script/transform`, so run `npm run build` before running that suite on its own.

### Code style

[Prettier](https://prettier.io/) formats and [ESLint](https://eslint.org/) lints, both run from the repo root:

```sh
npm run format                    # Format all source files
npm run format:check              # Check formatting without writing (CI)
npm run lint                      # Run ESLint (does not check formatting)
npm run typecheck --workspaces    # Typecheck the test files, which vitest does not (CI)
```

VS Code with the recommended Prettier extension formats on save, and `.editorconfig` covers indentation and line endings for other editors.

### Diagnostic messages

Every message a user sees from the compiler, the editor, or the CLI has the same shape.

- The first line is a short headline that says what is wrong and where, and stands on its own.
  It never says how to fix it.
- The headline starts in lowercase, unless it opens with a quoted name, and has no final period.
- Optional lines follow, each starting with `note: ` for context (why it matters, what the engine does) or `help: ` for a concrete fix the user can make.
  Each line holds one fact, in lowercase after the prefix and without a final period.
  A line is never a question.
- No semicolons anywhere in a message, and no "the following" or "as shown".
- Use plain words that are still technically exact.
  Name an engine class or method only when it explains the cause, and then in a `note:` line.
- Put code and names in single quotes.

```
'emit message Notify' sends nothing without a 'class', 'expression', 'delegate', or 'topic'
```

```
the condition must be boolean, but it is a string
note: the engine throws 'condition expression returns non-Boolean' when it evaluates it
```

The language package builds these with `diagnosticText` in `packages/language/src/vocabulary.ts`.

## Guidelines

### Reporting bugs

Use the [bug report template](https://github.com/BPMNscript/bpmnscript/issues/new?template=bug_report.yml).

### Suggesting features

Use the [feature request template](https://github.com/BPMNscript/bpmnscript/issues/new?template=feature_request.yml).

### Pull requests

- Reference the related issue with `Closes #...`.
- Describe what changed and why.
- Make sure `npm test`, `npm run lint`, `npm run format:check`, and `npm run typecheck --workspaces` all pass.

### Architectural decisions

Technical decisions are recorded as [Markdown ADRs](docs/decisions/) using [MADR 4.0.0](https://adr.github.io/madr/).
If your change makes an architectural decision, add an ADR for it.
