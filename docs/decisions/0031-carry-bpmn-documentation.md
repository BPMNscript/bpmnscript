---
status: accepted
date: 2026-09-10
decision-makers: Marlon Kranz
---

# Carry bpmn:documentation wherever a name is carried

## Context and Problem Statement

`bpmn:documentation` sits on `bpmn:BaseElement`, so it can appear on almost any element a document declares.
Import reads the child and drops it, reporting only a warning; there is no authoring surface, so nothing written in this language can produce it on export.
It is the one piece of authored, human-facing content this tool refuses to carry, which keeps the letter of the honest-import contract (ADR-0014) while working against everything else that contract exists for.

## Decision Drivers

- The honest-import contract (ADR-0014): nothing is dropped in silence, so whatever this surface still cannot carry must be named rather than swallowed.
- ADR-0029's one bracket shape: a new authoring surface is a setting inside an existing element's parens or it is a new construct, and documentation does not earn a construct of its own.
- The printer's `Lines = string[]` model indents per entry, so a value spanning several lines needs either a printer change or an escape.
- BPMN lets an element carry several `bpmn:documentation` children, each with its own `textFormat`.

## Considered Options

For the shape:

- One optional `documentation?: string` on the IR node
- A list of `{ text, textFormat }` members, one per `bpmn:documentation` child

For the printing:

- Escaping a newline so the value stays a single printed line
- Reworking the printer to give a setting a multi-line entry

For the placement:

- Every element the transform touches
- Every element that already carries a name

For the quoting:

- One quoting function serving every setting
- One quoting function per contract, splitting `quote()` in two

## Decision Outcome

Chosen: one optional `documentation?: string`, escaped onto a single printed line, carried wherever an IR node already carries a `name`, with the quoting function split in two.

Nothing in the corpus writes two `bpmn:documentation` children on one element, so a repeated member on every carrying kind would buy nothing a single optional string does not already give it; a second child, or one carrying a non-plaintext `textFormat`, keeps today's warning under a narrower message instead.
Escaping the newline keeps the printer's `Lines = string[]` model untouched, and Langium's default `convertString` is the exact inverse of that escape, so import and print stay symmetric without a change to how a line is stored.
Tying documentation to the name means the positions where it is reported instead are already the positions a label is reported: an element with no slot for a name has no slot for documentation either, so there is one rule rather than two.

One quoting function cannot serve a slot whose value must re-lex as an expression and a slot whose value must not.
A quoted body beginning with `${` is read as a raw expression, because `RAW_TEMPLATE` is declared before `STRING` in the grammar and matches first, and the reader that unwraps a raw expression strips its quotes without unescaping, so an escape inside such a body survives as two literal characters.
The settings that carry an expression, a delegate expression, a timer body, an io value, a loop collection, depend on that reading.
The settings that carry prose, a label, a version tag, a form field label, an error or escalation message, and now documentation, are corrupted by it instead.
A declared error or escalation code belongs on the prose side too, at the one site that quotes one, because ADR-0030 made a code a declared name and a declared name can never be an expression.
`quote()` splits on which contract a slot has: it keeps serving the expression-carrying group exactly as it does today, and `quoteLiteral()` takes the prose group, escaping what `quote()` escapes plus a newline plus a leading `$`.
Carrying documentation is what forces the split, not what creates the fault: the prose settings were already spelled ambiguously, and a value able to hold a newline is the first one that makes the ambiguity reachable.

### Consequences

- Good, because the `documentation` warning category survives with a narrowed meaning instead of disappearing, so a consumer classifying warnings by category needs no migration.
- Good, because documentation text is carried verbatim: a modeler's pretty-printed whitespace inside the element body comes back byte for byte instead of being trimmed in silence.
- Bad, because moving any other slot onto `quoteLiteral()` is a behaviour change rather than a refactor.
  Several settings still on `quote()`, such as a topic or a decision reference, can legitimately hold an expression in Operaton, so reclassifying one changes what a recompiled document runs and needs a decision of its own.

### Confirmation

The frozen `documentation` golden pair and its round-trip suite confirm the fixture compiles byte for byte, imports with no warning, and re-parses to the same IR at every hop.
A parameterized sweep on the import hop and one on the print hop each name every position that carries documentation and every position that reports it instead, so a position wired to neither branch fails the sweep rather than passing in silence.

## More Information

Amends ADR-0014, whose warned-construct list read `bpmn:documentation` on any element; the bullet now names the narrower set this decision leaves warned.

Related decisions: ADR-0029 (the bracket shape that keeps documentation a setting rather than a construct).
ADR-0030 (the declared-name rule that puts an error or escalation code on the same quoting side as documentation).
