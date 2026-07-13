---
status: accepted
date: 2026-07-04
decision-makers: Marlon Kranz
---

# Honest BPMN Import: Refuse Unsupported Constructs, Warn on Non-Semantic Drops

## Context and Problem Statement

`xmlToIr`'s docstring stated that silent semantic loss is impossible, but the transform
actually dropped several kinds of content without any diagnostic: event definitions on
start/end events (timer, message, signal, error, terminate), loop characteristics on tasks
(multi-instance and standard loop), whole collaborations (pools and message flows),
Operaton/camunda extension attributes beyond `assignee`/`formKey`/`class`, and lanes. Some of
these drops change what the imported process executes; others do not. The import contract
needs to make good on its own claim: what should happen when `xmlToIr` encounters content
the IR cannot carry, and should every such case be treated the same way?

## Decision Drivers

- The "no silent semantic loss" claim must hold for content whose absence changes execution
  semantics — a dropped timer or a dropped loop is not a cosmetic loss.
- Not every unrepresentable construct is equally severe. Refusing content that causes no
  semantic loss (an extension attribute, a lane) would make the importer unusable on any file
  a real modeler exports, since modelers routinely add such content.
- Whatever channel reports non-fatal drops must be impossible to ignore by accident — a
  warning nobody reads is equivalent to a silent drop.
- Consumers (the CLI, the VS Code extension) need one classification check ("is this an
  unsupported-construct refusal?") that does not have to enumerate every error subclass by
  hand as new ones are added.

## Considered Options

- Two-tier contract: refuse (throw) constructs that change execution semantics, warn (return)
  on constructs that do not
- Refuse everything the IR cannot express, with no warning tier
- Keep the current behavior (drop silently) and only correct the docstring to describe it

## Decision Outcome

Chosen option: "Two-tier contract: refuse constructs that change execution semantics, warn on
constructs that do not", because it is the only option consistent with the "no silent
semantic loss" claim while remaining usable on real Modeler-exported files, which routinely
carry cosmetic extension content that a total-refusal contract would reject outright.

**Refused** — a subclass of `UnsupportedConstructError` is thrown before any IR is produced,
so there is never a partial IR:

- an event definition on a start/end event → `UnsupportedEventDefinitionError`
- loop characteristics on a task → `UnsupportedLoopCharacteristicsError`
- a collaboration (pools/message flows) → `UnsupportedCollaborationError`
- an unsupported flow-element kind (pre-existing) → `UnsupportedElementError`
- an unsupported service-task execution form (pre-existing) → `UnsupportedServiceTaskFormError`

All five share the abstract base `UnsupportedConstructError`, so a consumer classifies every
refusal with a single `instanceof` check while each subclass still carries construct-specific
metadata for a tailored message.

**Warned** — returned in a `warnings: ImportWarning[]` array alongside the IR. `xmlToIr` now
returns `{ ir, warnings }` rather than a bare `BpmnProcess`:

- Operaton/camunda extension attributes and extension elements beyond the supported
  `assignee`/`formKey`/`class`
- lanes

Returning `{ ir, warnings }` — rather than an optional collector parameter
(`xmlToIr(xml, sink?)`) or a second function (`xmlToIrWithWarnings`) — makes the warnings
channel unignorable at the type level: every call site must destructure or explicitly discard
`warnings`, so a caller cannot silently drop the diagnostics this decision exists to
guarantee.

### Consequences

- Good, because every caller (the CLI, the VS Code extension, the round-trip test suite) now
  surfaces both the refusal and the warning channel instead of only one or neither.
- Good, because the shared `UnsupportedConstructError` base keeps consumer classification to
  one `instanceof` check as new refusal categories are added.
- Bad, because every call site of `xmlToIr` had to migrate from
  `const ir = await xmlToIr(xml)` to `const { ir } = await xmlToIr(xml)` — a one-time,
  mechanical, but repo-wide edit.
- Bad, because a handful of undeclared `operaton:` extension elements cannot be tied by
  `bpmn-moddle` to a specific owning element; their warnings are attributed to the process id
  rather than the precise element.

## More Information

The exact refuse/warn boundary and the `ImportWarning` shape (`elementId`, `category`,
`message`) are documented in `packages/transform/src/errors.ts` and
`packages/transform/src/xml-to-ir.ts`; a consumer-facing summary is in
`packages/transform/README.md`. Related: ADR-0006 (the shared IR — `warnings`
deliberately lives outside the IR, which stays serializable) and ADR-0007 (the Operaton
moddle extension fork, whose declared/undeclared elements determine warning-attribution
precision).
