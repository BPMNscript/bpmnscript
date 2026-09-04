---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Carry Operaton Engine Attributes as Named IR Fields

## Context and Problem Statement

The importer reports every piece of content it cannot represent, and Operaton's execution settings all land in the same bucket of that report, the `extensionAttribute` warning category.
`operaton:asyncBefore` and its async siblings are there, along with the job priority, the retry cycle, the `operaton:inputOutput` block, execution and task listeners, and every user-task assignment attribute beyond `assignee` and `formKey`.
A process that round-trips through this tool therefore comes out without them.
That makes the tool unusable on a file a real deployment produced, because those settings are how a modeler tunes what the engine does with a step.

None of them changes control flow.
An async continuation decides where the engine commits a transaction, an input parameter decides what a delegate reads, and a listener decides what runs alongside a step; not one of them adds a node, a branch, or a sequence flow.
Carrying them needs no change to gateway synthesis or to structural recovery, only somewhere to put the values and a mapping on each of the four transforms.

Where in the IR should roughly twenty engine settings live, and under what names?

## Decision Drivers

- ADR-0006 fixed both the shape of the IR and the naming inside it: a small statically typed graph, modelling what Operaton executes under field names that carry no vendor prefix.
  Twenty fields arriving at once is enough to change the character of a model that small, so the shape has to be checked against that convention rather than assumed to fit it.
- The validator checks attribute keys against the kind of element carrying them, which is what turns a misspelled `assignee` into an error before anything compiles.
  A setting the IR cannot name is a key the validator cannot check.
- Round-trip idempotence is verified by comparing one IR against another, so a carried setting has to be a field that a structural comparison can see rather than text riding through in an opaque container.
- Three of these settings are not flat.
  An input or output parameter's value can be a list, a map, or an inline script, and a listener carries an event plus exactly one binding out of four, so whatever shape works for `asyncBefore` has to work for those as well.

## Considered Options

- Named vendor-neutral fields on the IR node
- A generic extension bag keyed by qualified attribute name
- Openly `operaton:`-prefixed field names

## Decision Outcome

Chosen option: "Named vendor-neutral fields on the IR node", because the IR already carries `assignee`, `formKey`, and the service-task and call-activity bindings exactly that way, so this work follows a precedent instead of amending one.

Each setting becomes an optional field on the IR node that owns it, named for what it means rather than for how it serializes.
The retry cycle is `retryCycle`, not `failedJobRetryTimeCycle`.
`asyncBefore` and `asyncAfter` are stored only when set, and `exclusive` only when `false`, because the engine's defaults are off, off, and on; storing a default would put a value in the IR that the source never wrote.
The settings a flow node can carry group into one mixin interface and the input/output block into a second, so a node kind declares which groups it carries by extending them, and the two nested groups get tagged unions whose variants make an illegal combination unrepresentable rather than runtime-checked.

ADR-0006 also says that an attribute varying only at serialization is attached at the IR-to-XML boundary and not stored at all, which is what happens to `operaton:historyTimeToLive`.
These settings are a different case, since an author writes them and the IR has to carry what was written.
What still applies is the naming rule ADR-0006 states alongside it, that IR field names carry no vendor prefix and Operaton attributes go on at the IR-to-XML boundary.
The value is stored under a plain name, and `irToXml` adds `operaton:` at the one point where it builds the moddle element.

There is one thing this surface deliberately cannot do.
Every exclusive and parallel gateway in a compiled process is synthesized from a compound statement: an `if`, a `while` or `do...while` loop, or a `parallel`.
Such a gateway has no textual identity in the source, because its id is a structural coordinate derived from that statement's position (ADR-0010).
The statement itself takes no attribute block, so there is nowhere to write the setting either.
No engine attribute can be authored on a gateway, gateways therefore carry neither mixin, and an `operaton:asyncBefore` found on a gateway during import stays in the `extensionAttribute` warning bucket where it is today.
This is a scoped limit of the block-structured surface (ADR-0008) rather than an oversight, and nothing in this repository attempts to close it.
Closing it would mean giving a synthesized gateway a name an author can write, which is a decision about how blocks are spelled and not a decision about the IR.

### Consequences

- Good, because the validator can restrict attribute keys per element kind.
  A user task's keys, a service task's keys, and a call activity's keys are three named sets, so an unknown key is an error attributed to the element that carries it instead of a value that rides through untouched.
- Good, because the IR stays a typed model.
  A field that exists on a user task and not on a start event is a compile error at every call site, and a round-trip comparison sees each setting as a field rather than as a string it has to parse.
- Good, because the vendor prefix stays on the serialization boundary, so the IR reads the same whether or not the reader knows what Operaton is.
- Bad, because every engine setting is now a mapping surface on all four transforms.
  Adding one means a grammar key, a validator entry, a lowering, an XML attribute or extension child, an import read, and a printer case, which is the cost ADR-0006 already named for the extra layer, multiplied by the size of this group.
- Bad, because a setting Operaton supports and the IR does not name is still dropped with a warning, and closing that gap is a code change rather than a passthrough.
  `operaton:field` is the current example: the moddle extension declares it so the drop can be attributed to the step that carried it, but nothing carries it.
- Neutral, because an imported gateway carrying engine attributes still loses them, and the import warning continues to report that drop.

## Pros and Cons of the Options

### Named vendor-neutral fields on the IR node

One optional field per setting, on the node kinds that can carry it, grouped into mixin interfaces where the same set applies to many kinds.

- Good, because it extends what the IR already does for `assignee`, `formKey`, and the service-task binding, so there is one convention in the file afterwards rather than two.
- Good, because the type system does the work the validator would otherwise have to repeat: a listener's binding is a tagged union of four variants, so a listener with two bindings or none cannot be constructed.
- Good, because the DSL surface follows from the field names directly, and an author writes `asyncBefore = true` in the attribute block the language already has.
- Bad, because a setting nobody has named yet is not carried, so keeping up with the engine means editing code rather than widening a container.

### A generic extension bag keyed by qualified attribute name

A single map from namespaced attribute name to value on every node, filled with whatever the importer found and written back verbatim on export.

- Good, because it would carry every Operaton attribute at once, including the ones nobody has looked at, and a new engine release would need no change here.
- Good, because the warning bucket would empty without a per-setting mapping on four transforms.
- Bad, because the DSL surface it implies is untyped.
  An author could write any key at all, the validator would have nothing to check it against, and a typo would compile to an attribute the engine ignores at runtime with no diagnostic anywhere along the way.
- Bad, because the IR would stop being a model of what a process does and start being a copy of the document it came from.
  ADR-0006 chose the IR precisely so that restructuring and gateway synthesis run against a typed graph rather than against moddle's serialization-bound objects, and a bag of qualified attribute names walks that back one node at a time.
- Bad, because a flat map cannot hold the nested shapes.
  An input parameter's value can be a list of maps and a listener carries an event plus a binding, and the encoding that would squeeze either into a string-to-string map is a document tree under a different name.

### Openly `operaton:`-prefixed field names

Fields spelled `operatonAsyncBefore` and `operatonJobPriority`, or one `operaton` sub-object per node holding all of them.

This is the most honest of the three options, and the argument for it deserves to be stated plainly.
The project targets Operaton, portability across engines is a declared non-goal, and every field in this group exists because one engine reads it.
A prefix would say that at the point of use instead of leaving it to a paragraph in a record.

- Good, because a reader of the IR types would see at a glance which fields are BPMN's own and which exist for one engine.
- Good, because a second engine could later be added without a name collision.
- Bad, because it contradicts a naming rule ADR-0006 set and the IR already follows.
  `assignee`, `formKey`, and the service-task binding are engine settings carried under plain names today, so a prefix would mean either renaming them, which is churn across four transforms for no change in behaviour, or keeping two conventions in one file.
- Bad, because the prefix would either leak into the DSL, where an author has no reason to type it, or force a translation table between attribute key and field name that exists only to undo the prefix.
- Neutral, because the honesty a prefix offers is already on the record: ADR-0006 states the single-engine target and the portability non-goal in prose, and ADR-0007 explains where the `operaton:` types come from.

## More Information

Each field documents its serialized form beside its declaration in `packages/transform/src/ir/types.ts`, and the prefix is applied only in `packages/transform/src/ir-to-xml.ts`.
The import side records what is now carried and what is still dropped in `packages/transform/src/xml-to-ir.ts` and in `packages/transform/README.md`, including the gateway limit, so a user who reads a warning about a gateway finds the reason without reading this record.

Related decisions: ADR-0006 set the IR's shape and its no-vendor-prefix naming rule, which this decision applies rather than revises.
ADR-0007 covers the moddle extension that declares the `operaton:` types this maps onto.
ADR-0008 and ADR-0010 explain the block-structured grammar and the synthesized structural ids that together make the gateway limit what it is.
ADR-0023 covers the DSL spelling for listeners, the one part of this group whose surface needed a decision of its own.
