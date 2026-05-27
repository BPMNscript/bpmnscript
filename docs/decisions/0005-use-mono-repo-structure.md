---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use Mono-repo Structure

## Context and Problem Statement

BPMNscript consists of multiple components: the core language (grammar, parser, AST, validation), a CLI tool, and a VS Code extension.
Should these components live in a single repository or be split across multiple repositories?

## Decision Drivers

* Simplicity of build and CI configuration for a solo thesis project
* Ability for the thesis supervisor to review the entire project in one place
* Langium projects conventionally use npm workspaces in a mono-repo

## Considered Options

* Mono-repo with npm workspaces
* Multi-repo (separate repos for core, CLI, VS Code extension)

## Decision Outcome

Chosen option: "Mono-repo with npm workspaces", because it minimizes operational overhead for a solo thesis project while maintaining clear module boundaries via the `packages/` directory structure.

### Consequences

* Good, because a single CI pipeline covers all components
* Good, because cross-package changes are atomic (single commit, single PR)
* Good, because Langium's scaffolding generator produces this layout by default
* Neutral, because npm workspaces add slight complexity to the root `package.json`
