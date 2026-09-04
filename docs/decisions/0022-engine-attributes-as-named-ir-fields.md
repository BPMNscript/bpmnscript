---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Carry Operaton Engine Attributes as Named IR Fields

## Context and Problem Statement

The importer reports everything it cannot represent in the `extensionAttribute` warning category, and Operaton's execution settings all land there: `asyncBefore` and its siblings, job priority, the retry cycle, `operaton:inputOutput`, execution and task listeners, and every user-task assignment attribute beyond `assignee` and `formKey`.
A process that round-trips through this tool comes out without them, which makes the tool unusable on a file a real deployment produced.
None of these settings changes control flow.
An async continuation decides where the engine commits a transaction, an input parameter decides what a delegate reads, and a listener decides what runs alongside a step.
Carrying them needs no change to gateway synthesis, only somewhere to put roughly twenty values and a mapping on each of the four transforms.

Where in the IR should these settings live, and under what names?

## Decision Drivers

- ADR-0006 fixed the IR's shape and its no-vendor-prefix naming convention, so twenty fields arriving at once has to fit that convention rather than be assumed to.
- The validator checks attribute keys against element kind, and round-trip idempotence compares IR against IR, so a carried setting has to be a typed field a structural comparison can see, not opaque text.
- Three settings are not flat: an input or output parameter's value can be a list, a map, or an inline script, and a listener carries an event plus one of four bindings.

## Considered Options

- Named vendor-neutral fields on the IR node
- A generic extension bag keyed by qualified attribute name
- Openly `operaton:`-prefixed field names

## Decision Outcome

Chosen option: "Named vendor-neutral fields on the IR node", because the IR already carries `assignee`, `formKey`, and the service-task and call-activity bindings this way, extending a precedent rather than amending one.

Each setting becomes an optional field on the IR node that owns it, named for what it means rather than how it serializes, so the retry cycle is `retryCycle`, not `failedJobRetryTimeCycle`.
`asyncBefore`, `asyncAfter`, and `exclusive` are stored only when they diverge from the engine's off/off/on defaults, and flow-node settings group into one mixin interface while input/output groups into a second, both as tagged unions so an illegal combination is unrepresentable.
The naming rule from ADR-0006 still applies at the boundary: values are stored under plain names, and `irToXml` adds the `operaton:` prefix at the one point where it builds the moddle element.

A gateway synthesized from an `if`, `while`, `do...while`, `parallel`, or a multi-branch `await` has no textual identity to hang an attribute on (ADR-0010), so no engine attribute can be authored on one.
An `operaton:asyncBefore` found on a gateway during import stays in the `extensionAttribute` warning bucket, a scoped limit of the block-structured surface (ADR-0008) rather than an oversight.

### Consequences

- Good, because the validator can restrict attribute keys per element kind, and the vendor prefix stays on the serialization boundary, so the IR reads the same regardless of whether the reader knows Operaton.
- Good, because the IR stays a typed model: a field on a user task but not a start event is a compile error at every call site, and a round-trip comparison sees a field rather than a string to parse.
- Bad, because every engine setting is now a mapping surface on all four transforms: a grammar key, a validator entry, a lowering, an XML mapping, an import read, and a printer case.
- Bad, because a setting Operaton supports and the IR does not name is still dropped with a warning rather than carried (`operaton:field` is the current example).

## Pros and Cons of the Options

### Named vendor-neutral fields on the IR node

- Good, because it extends what the IR already does for `assignee`, `formKey`, and the service-task binding, keeping one convention rather than two.
- Good, because the type system does validation work directly: a listener's binding is a tagged union of four variants, so one with two bindings or none cannot be constructed.
- Bad, because a setting nobody has named yet is not carried, so keeping up with the engine means editing code rather than widening a container.

### A generic extension bag keyed by qualified attribute name

- Good, because a map filled from import and written back verbatim would carry every Operaton attribute at once, including ones nobody has looked at.
- Bad, because the DSL surface it implies is untyped: any key would compile, and a typo would produce an attribute the engine never reads and never complains about.

### Openly `operaton:`-prefixed field names

- Good, because fields like `operatonAsyncBefore` would let a reader see which fields are BPMN's own versus a single engine's, and a second engine could later be added without a name collision.
- Bad, because it contradicts the naming rule ADR-0006 already set: `assignee`, `formKey`, and the service-task binding are engine settings under plain names today, so a prefix means renaming them or keeping two conventions in one file.

## More Information

Each field's serialized form is documented beside its declaration in `packages/transform/src/ir/types.ts`, and the prefix is applied only in `packages/transform/src/ir-to-xml.ts`.
The import side records what is carried and what is still dropped in `packages/transform/src/xml-to-ir.ts` and `packages/transform/README.md`.

Related decisions: ADR-0006 (IR shape and naming rule, applied here), ADR-0007 (the `operaton:` moddle extension), ADR-0008 and ADR-0010 (block-structured grammar and synthesized ids, which set the gateway limit), ADR-0023 (DSL spelling for listeners).
