---
status: accepted
date: 2026-04-13
decision-makers: Marlon Kranz
---

# Use VS Code as Primary IDE Target

## Context and Problem Statement

BPMNscript's IDE support (syntax highlighting, autocomplete, jump-to-definition, inline errors) must be delivered through an editor extension.
Which IDE should be the primary target?

## Decision Drivers

* IDE support is the core value proposition of a textual DSL
* The chosen language workbench (Langium, see [ADR-0001](0001-use-langium-as-language-workbench.md)) natively targets VS Code
* VS Code is the most widely used editor among developers
* The Language Server Protocol (LSP) enables secondary IDE support without full reimplementation

## Considered Options

* VS Code (primary) with IntelliJ as stretch goal via LSP
* IntelliJ (primary) via Grammar-Kit
* Eclipse (primary) via Xtext

## Decision Outcome

Chosen option: "VS Code (primary) with IntelliJ as stretch goal via LSP", because Langium generates a VS Code extension natively, and LSP provides a path to IntelliJ support via LSP4IJ without additional framework-specific work.

### Consequences

* Good, because Langium generates a working VS Code extension from the grammar with no additional framework
* Good, because LSP-based architecture enables IntelliJ support (via LSP4IJ) as a secondary target
* Good, because the same language server can be reused in a browser-based Monaco editor
* Neutral, because IntelliJ integration via LSP is functional but lacks deep features such as native syntax highlighting
