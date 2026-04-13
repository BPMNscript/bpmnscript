# Contributing to BPMNscript

> **Note:** This project is under active development as part of a Bachelor thesis at the University of Hamburg.
> External contributions are not accepted until after thesis submission.
> After that, the guidelines below will apply.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [VS Code](https://code.visualstudio.com/)

### Getting Started

```bash
git clone https://github.com/BPMNscript/bpmnscript.git
cd bpmnscript
npm install
npm run langium:generate
npm run build
```

### Development Workflow

1. Open the project in VS Code
2. Press <kbd>F5</kbd> to launch the Extension Development Host
3. Create or open a `.bs` file in the new window

### Running Tests

```bash
npm test
```

### Code Style

- This project uses ESLint for linting
- Run `npm run lint` to check for issues
- Ensure your editor respects the `.editorconfig` settings

## Guidelines (Post-Thesis)

### Reporting Bugs

Use the [bug report template](https://github.com/BPMNscript/bpmnscript/issues/new?template=bug_report.yml).

### Suggesting Features

Use the [feature request template](https://github.com/BPMNscript/bpmnscript/issues/new?template=feature_request.yml).

### Pull Requests

- Reference the related issue with `Closes #...`
- Include a brief description
- Update the CHANGELOG.md
- Ensure all tests pass
- Update `external-libraries.md` if adding new dependencies

### Architectural Decisions

Non-trivial technical decisions are documented as [Markdown Architectural Decision Records (MADRs)](docs/decisions/) using [MADR 4.0.0](https://adr.github.io/madr/).
If your change involves an architectural decision, please include a new ADR.
