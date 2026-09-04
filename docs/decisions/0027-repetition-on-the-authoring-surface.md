---
status: accepted
date: 2026-08-31
decision-makers: Marlon Kranz
---

# Repetition on the Authoring Surface: the `for` Clause

## Context and Problem Statement

Any BPMN activity may carry a `bpmn:multiInstanceLoopCharacteristics` child, which makes the engine run it once per element of a collection or a fixed number of times.
This grammar had no way to say so, so a document carrying one refused on import and the round trip stopped there.
Where does the repetition sit on a statement, what does it spell, and which shapes does the surface decline to carry?

## Decision Drivers

- ADR-0013 binds a keyword to what the author means rather than to the BPMN attribute behind it.
- ADR-0010 requires an imported activity to come back under the id the document gave it.
- ADR-0014 refuses what changes the run and warns only about drops that do not.
- A Langium keyword is lexer-global, so a word spent on a clause is a name lost everywhere in a file.
- Operaton decides what is legal here, and a surface stricter than the engine owes a reason.

## Considered Options

- A header clause between a statement's label and its settings block
- Settings-block keys, `times =`, `each =`, `as =`, and `sequential = true`
- A wrapping statement, `for each x in c { ... }`
- One head for both a count and a collection
- Two heads, `for each ... in ...` for a collection and `repeat <n>` for a count
- The element variable required
- The element variable optional
- `bpmn:standardLoopCharacteristics` imported as a step that runs once
- `bpmn:standardLoopCharacteristics` refused

## Decision Outcome

Chosen options: the header clause, one head, the optional element variable, and the refusal of standard loop characteristics.

The clause reads `for each line in lines`, `for each in lines`, `for 3`, or `for 2 each line in lines`, with `sequentially` and `until (<condition>)` after it.
It sits between the optional label and the optional settings block on the nine statements that emit an activity.
`for`, `each`, `sequentially`, and `until` are hard keywords, because in that position only a keyword can tell the parser a clause has started.
No file in the repo used any of the four in an identifier position, and the four built into a live parser drew no ambiguity report from Chevrotain's self-analysis.

Settings-block keys were the cheap option.
They lose on ADR-0013, whose test `sequential = true` fails outright, being the XML attribute wearing a DSL hat.
A flat key/value block also cannot constrain what the clause constrains: `as = "line"` with no `each =` is writable as settings, and it is one of the deployments Operaton refuses.

The wrapping form loses on ADR-0010.
BPMN attaches a repetition to exactly one activity, so a wrapper holding two statements has to synthesize a sub-process to hang it on.
An imported repeated user task would then come back inside a container the document never had, under an id this tool invented, which is the identity ADR-0010 exists to protect.
A wrapper restricted to one statement is this clause with a pair of braces around it.

One head carries both intents because Operaton allows both at once.
Its `MultiInstanceActivityBehavior.resolveNrOfInstances` reads the cardinality first and falls through to the collection, and `evaluateCollectionVariable` still binds the element per run whenever a collection is set.
Two heads would have to refuse that combination or grow a third spelling for it.

Parallel is the unmarked form, because Operaton's `BpmnParse` defaults `isSequential` to false and this tool elides every attribute matching an engine default.
An element variable is optional with a collection: `for each in batches` is a collection that drives the count and binds nothing, which deploys and runs.
Refusing that for authoring convenience is the call ADR-0026 declined to make for a receive task with no message name.

Operaton reads an `operaton:collection` value containing `{` as an expression and anything else as the literal name of a process variable, so the two readings are not interchangeable.
A collection spelled as a plain identifier therefore prints bare and everything else prints quoted, since a bare `order.lines` would name a variable that does not exist.
The whole construct is one optional field on the shape the seven activity nodes already share, so it reached every kind without adding an arm to any exhaustive switch in the transform.

An `asyncBefore`, `asyncAfter`, or `exclusive` written on the `multiInstanceLoopCharacteristics` element refuses on import, because Operaton's `parseAsynchronousContinuationForActivity` hands that element to `parseAsynchronousContinuation`, which reads those three onto each run rather than around the repetition, and no clause here can say that.
An `operaton:failedJobRetryTimeCycle` there refuses for the same reason by another route, Operaton's `DefaultFailedJobParseListener` reading the one written on the repetition element onto each run and the one written on the step around the whole repetition.
An `operaton:jobPriority` there is reported as a drop instead, because Operaton reads a job priority only in `createActivityOnScope`, off the step, and the repetition's own scope is never built there, so the setting reaches no job.
An `operaton:outputParameter` on a repeated step refuses, because Operaton's `checkActivityOutputParameterSupported` rejects the deployment outright, and the validator stops an author writing one for the same reason.
A `bpmn:standardLoopCharacteristics` refuses, because Operaton's `parseActivity` looks only for the multi-instance child, so the document deploys and the step runs once.
A `bpmn:loopCardinality` body that is neither a run of digits nor an expression refuses, and that one is this tool's limit rather than the engine's.
Operaton's `resolveLoopCardinality` reads `+3` as three, while this printer writes a count only as a plain number or as an expression, so the body would come back spelled differently.
An `operaton:elementVariable` or a `bpmn:inputDataItem` name outside the grammar's `ID` terminal refuses on the same ground, since the clause writes the name each run sees as a bare identifier and has no second form for it: an element named `größe` would come back as a file this language cannot parse.
Operaton's own parse errors refuse here rather than importing into a process that cannot deploy: a repetition with neither a count nor a collection, an element variable with no collection, and an empty `bpmn:loopCardinality`.

### Consequences

- Good, because a document the engine runs more than once now imports, prints, and recompiles byte for byte, where before it stopped the import at the first repeated activity.
- Bad, because `asyncBefore = true` in a repeated step's settings block no longer means what it meant before the clause existed.
  Operaton's `parseAsynchronousContinuationForActivity` reads a host element's async attributes onto the repetition, so it is one job around the whole loop rather than one per run.
  It is the only async this surface can express, and it is what an author writing it there usually means.
- Neutral, because `operaton:collection` and `bpmn:loopDataInputRef` are one field to Operaton's `parseMultiInstanceLoopCharacteristics`, read in that order, so they import into one field here and the `operaton:` spelling is what gets written back.
  The BPMN slot holds the text of a variable name rather than a reference to an element in the document.
  `bpmn:inputDataItem` and `operaton:elementVariable` pair the same way, and a document setting both spellings of either pair gets a warning naming the one that was dropped.
- Neutral, because a decompiled program declares `var <name>: any` for every collection it iterates by name.
- Neutral, because `nrOfInstances`, `nrOfActiveInstances`, `nrOfCompletedInstances`, and `loopCounter` are seeded into the process's variable table wherever something repeats, so `until (nrOfCompletedInstances >= 2)` validates with no declaration.
  Operaton's `MultiInstanceActivityBehavior` sets `loopCounter`, and its two concrete behaviors set the three counters.
- Bad, because four ordinary English words stop being available as identifiers anywhere in a file.

### Confirmation

`packages/language/test/` pins every form of the clause token by token, its placement against the label and the settings block, the output-parameter rule, the seeded variables, and what the position completes to.
`packages/transform/test/` pins the lowering, each refusal by error class and by a substring of its message, each shadowing warning, the emitted child, and the printed line.
The frozen pair `tests/golden/repetition.{bpmnscript,bpmn}` carries every form of the clause across eight statements of one process, and `tests/repetition.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/e2e/repetition.test.ts` deploys to a real Operaton and drives it over REST, offering a parallel repetition's three runs at once and a sequential one's one at a time on the same activity.
A completion condition ends a repetition after two runs, a count drives a service task, a collection binds each element in turn, and a count of zero never runs the step inside.

## Pros and Cons of the Options

### A header clause between a statement's label and its settings block

- Good, because the repetition reads as something done to one statement, which is what the engine does with it, and every statement keeps the block it already had.
- Bad, because it spends four keywords and touches nine grammar rules where the settings-block form would have touched none.

### Settings-block keys

- Bad, because `sequential = true` names the BPMN attribute rather than what the author means, which is the one thing ADR-0013 rules out.

### A wrapping statement

- Bad, because a wrapper over more than one statement needs a synthesized sub-process, so an imported activity comes back inside a container carrying an id the document never had.

### Two heads

- Bad, because a count and a collection are not exclusive in Operaton, so two heads would refuse a legal document or need a third spelling for the combination.

### The element variable required

- Bad, because a collection with no element variable deploys and runs, so the requirement costs an error path and a test to reject content the engine executes.

### `bpmn:standardLoopCharacteristics` imported as a step that runs once

- Bad, because it hands back a script saying a step repeats where the engine runs it once, which is a worse answer than a refusal naming the element.

## More Information

Related decisions: ADR-0010 (the synthesized ids a wrapping form would have had to invent).
ADR-0013 (the rule that a keyword names what the author means, and the reason `sequential = true` is not one).
ADR-0014 (the honest import contract behind every refusal and every warning here).
ADR-0026 (the same call on a receive task with no message name, reused here for a collection with no element variable).
