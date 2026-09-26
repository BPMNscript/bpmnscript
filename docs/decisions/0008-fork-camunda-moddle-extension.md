---
status: accepted
date: 2026-05-21
decision-makers: Marlon Kranz
---

# Fork the Camunda moddle extension as a local Operaton one

## Context and Problem Statement

`bpmn-moddle` supports vendor-specific BPMN extension attributes through named extension descriptors.
The bpmn.io ecosystem publishes `camunda-bpmn-moddle`, which adds `camunda:`-prefixed attributes (`camunda:class`, `camunda:assignee`, `camunda:formKey`, `camunda:historyTimeToLive`).
Operaton uses the same attribute names but under its own prefix (`operaton:`) and namespace URI (`http://operaton.org/schema/1.0/bpmn`).
Operaton does not publish an equivalent moddle extension package.

How should BPMNscript register Operaton's extension attributes with `bpmn-moddle`?

## Decision Drivers

- Emitted XML must carry the `operaton:` prefix and namespace.
  `camunda:` is accepted for legacy support, but Operaton officially recommends using `operaton:`.
- Registering two extensions that define the same attribute names on the same BPMN type causes a name collision in `bpmn-moddle`'s extension registry.
- Only a subset of Operaton's extension attributes is needed as of now; carrying the full Camunda descriptor adds unnecessary complexity.
- Minimizing external dependencies reduces maintenance burden.

## Considered Options

- Load `camunda-bpmn-moddle` and post-process the serialized XML to rewrite the namespace, which reuses an established, maintained package but is fragile: string-replacing prefixes after serialization risks corrupting `xmlns` declarations or attribute values that contain the prefix string, and the `camunda:` and `operaton:` extensions cannot be loaded side by side because `bpmn-moddle` collides on identically named attributes
- Ship a trimmed fork of the Camunda descriptor with prefix and URI replaced

## Decision Outcome

Chosen option: "Ship a trimmed fork", because it avoids namespace collisions, eliminates fragile string-replacement post-processing, and keeps the descriptor small and auditable.
The fork is based on `camunda-bpmn-moddle/resources/camunda.json` from the `camunda/camunda-bpmn-moddle` repository on GitHub, with the prefix and namespace URI replaced and only the attributes BPMNscript uses kept.

### Consequences

- Good, because emitted XML correctly carries `xmlns:operaton` and `operaton:`-prefixed attributes without post-processing.
- Good, because the descriptor defines only the attributes actually used, which keeps it easy to review and extend.
- Good, because no external dependency is needed for the Operaton namespace.
- Bad, because if Operaton publishes an official moddle extension in the future, the local fork must be replaced.
- Bad, because the fork must be maintained manually when new Operaton attributes are needed.
