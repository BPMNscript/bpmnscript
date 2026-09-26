---
status: accepted
date: 2026-08-31
decision-makers: Marlon Kranz
---

# Repetition: the `for` clause and its per-run job settings

## Context and Problem Statement

Any BPMN activity may carry a `bpmn:multiInstanceLoopCharacteristics` child, which makes the engine run it once per element of a collection or a fixed number of times.
A grammar with no way to say so refuses such a document on import and stops the round trip at the first repeated activity.
That element also carries job settings of its own.
`BpmnParse.parseAsynchronousContinuationForActivity` hands a multi-instance activity's `bpmn:multiInstanceLoopCharacteristics` element to `parseAsynchronousContinuation`, so the three async settings written there mean one job per run, where the same settings on the activity element mean one job around the whole repetition.
`DefaultFailedJobParseListener.parseActivity` reads a retry cycle off that element the same way, and a document a real deployment produced can carry any of the four on it.

Where does the repetition sit on a statement, what does it spell, which shapes does the surface decline to carry, and where does a per-run job setting go?

## Decision Drivers

- A keyword binds to what the author means rather than to the BPMN attribute behind it.
- An imported activity has to come back under the id the document gave it.
- The import contract refuses what changes the run and warns only about drops that do not.
- A Langium keyword is lexer-global, so a word spent on a clause is a name lost everywhere in a file.
- Operaton decides what is legal here, and a surface stricter than the engine owes a reason.
- The one bracket shape holds every scalar setting in a parens on the statement head, and a per-carrier prefix already tells a second carrier's settings apart inside one parens (ADR-0021).

## Considered Options

- A header clause between a statement's id and its settings, which reads as something done to one statement, which is what the engine does with it, and leaves every statement the settings it already had, at the cost of four keywords and a touch on every statement rule that emits an activity where a settings key would have touched none.
- Settings keys, `times:`, `each:`, `as:`, and `sequential: true`, which name the BPMN attribute rather than what the author means, and cannot constrain what the clause constrains, since `as: "line"` with no `each:` is writable as a setting and is one of the deployments Operaton refuses.
- A wrapping statement, `for each x in c { ... }`, which over more than one statement needs a synthesized sub-process to hang the repetition on, so an imported repeated user task comes back inside a container the document never had under an id this tool invented, and which restricted to one statement is this clause with a pair of braces around it.
- One head for both a count and a collection, since the two are not exclusive in Operaton.
- Two heads, `for each ... in ...` for a collection and `repeat <n>` for a count, which would refuse a legal document carrying both or need a third spelling for the combination.
- The element variable required, which costs an error path and a test to reject content the engine deploys and runs.
- The element variable optional, matching what the engine accepts.
- `bpmn:standardLoopCharacteristics` imported as a step that runs once, which accepts every document Operaton deploys and runs, on every host the loop can sit on including an event handler, at the price of dropping the element the document wrote and keeping only a warning that names it.
- `bpmn:standardLoopCharacteristics` refused, which rejects a document the engine deploys and runs exactly as if the element were absent.
- Per-run job settings as four keys in the statement's own parens, prefixed `run`, reusing the bracket shape at no grammar cost and reusing the derivation a join gateway's spellings use, so the validator, the printer, and the importer read one function for both prefixes, at the price of a parens holding nine keys at once.
- A second parens attached to the `for` clause itself, which would sit a run's settings next to the clause that creates the runs, but is a second bracket shape for four settings that already have a home elsewhere.
- The per-run settings spelled inside the clause's own grammar, which is a phrase grammar rather than a keyed settings list, so folding four settings into it needs new syntax for each one.

## Decision Outcome

Chosen options: the header clause, one head, the optional element variable, importing a standard loop as a step that runs once, and four `run`-prefixed keys in the statement's own parens.

The clause sits between the id and the optional settings on the statements that emit an activity, and `for`, `each`, `sequentially`, and `until` are hard keywords, because in that position only a keyword can tell the parser a clause has started.
No file in the repo uses any of the four in an identifier position, and the four built into a live parser draw no ambiguity report from Chevrotain's self-analysis.

One head carries both intents because Operaton allows both at once: `MultiInstanceActivityBehavior.resolveNrOfInstances` reads the cardinality first and falls through to the collection, and `evaluateCollectionVariable` still binds the element per run whenever a collection is set.
Parallel is the unmarked form, because Operaton's `BpmnParse` defaults `isSequential` to false and this tool elides every attribute matching an engine default.
An element variable is optional with a collection, since `for each in batches` deploys and runs, and refusing it for authoring convenience is the call ADR-0016 declined to make for a receive task with no message name.
The whole construct is one optional field on the shape the activity nodes already share, so it reaches every kind without adding an arm to any exhaustive switch in the transform.

`runAsyncBefore`, `runAsyncAfter`, `runExclusive`, and `runRetryCycle` sit in the same parens a repeated statement's own five settings already occupy, each spelled by `runSettingKey(key) = prefixedSettingKey('run', key)`, the same function a join gateway's spellings use with a different prefix.
There is no `runJobPriority`: `createActivityOnScope` reads a job priority off the activity element alone, and `parseActivity` swaps the scope to the multi-instance body before `createActivityOnScope` stores it, so a repeated step's plain `jobPriority` already prices each run's job.
No statement kind that repeats also synthesizes a gateway, so a `run`-prefixed key and a `join`-prefixed key never both sit in one parens.

On the XML side the loop element carries the plain, unprefixed attribute names, since it is already its own element, distinct from the activity's, and only the DSL surface needs a prefix where the step's settings and the loop's share one parens.
The moddle declaration makes the plain names legal and typed on that element in the first place: `AsyncCapable.extends` in `operaton-moddle.json` gains `bpmn:MultiInstanceLoopCharacteristics` beside `bpmn:FlowNode`, which upstream camunda-bpmn-moddle already declares there through `Collectable`'s own superclass, and without it the loop element's `asyncBefore` and friends parse into `$attrs` as untyped strings, invisible to every typed reader.
The four therefore import back as the matching `run`-prefixed settings rather than refusing.

Two refusals on import are this tool's limit rather than the engine's, and both exist because the printer has no second spelling to write the content back in.
A `bpmn:loopCardinality` body that is neither a run of digits nor an expression refuses, since Operaton's `resolveLoopCardinality` reads `+3` as three while this printer writes a count only as a plain number or as an expression, and an `operaton:elementVariable` or `bpmn:inputDataItem` name outside the grammar's `ID` terminal refuses, since the clause writes the name each run sees as a bare identifier and an element named `größe` would come back as a file this language cannot parse.
Everything Operaton's own parse rejects, a repetition with neither a count nor a collection among it, refuses rather than importing into a process that cannot deploy.

### Consequences

- Good, because a document the engine runs more than once imports, prints, and recompiles byte for byte, including one carrying async or retry settings on its multi-instance element.
- Good, because no new IR shape was needed: `LoopCharacteristics` already existed, and every read, write, import, and print helper built for `JobSettings` applies to it unchanged, keyed by a different function.
- Neutral, because a repeated step's own `asyncBefore` and `asyncAfter` buy one job around the whole loop, `parseAsynchronousContinuationForActivity` reading a host element's async attributes onto the repetition, while `runAsyncBefore` and `runAsyncAfter` in the same parens buy one job per run.
- Neutral, because `operaton:collection` and `bpmn:loopDataInputRef` are one field to Operaton's `parseMultiInstanceLoopCharacteristics`, read in that order, so they import into one field here and the `operaton:` spelling is what gets written back.
  The BPMN slot holds the text of a variable name rather than a reference to an element in the document.
  `bpmn:inputDataItem` and `operaton:elementVariable` pair the same way, and a document setting both spellings of either pair gets a warning naming the one that was dropped.
- Neutral, because a decompiled program declares `var <name>: any` for every collection it iterates by name, one case of the rule that the print declares every variable it reads.
- Neutral, because `nrOfInstances`, `nrOfActiveInstances`, `nrOfCompletedInstances`, and `loopCounter` are seeded into the process's variable table wherever something repeats, so `until (nrOfCompletedInstances >= 2)` validates with no declaration.
  Operaton's `MultiInstanceActivityBehavior` sets `loopCounter`, and its two concrete behaviors set the three counters.
- Bad, because four ordinary English words stop being available as identifiers anywhere in a file.
- Bad, because a repeated statement's parens can hold nine keys, five plain and four `run`-prefixed, so a reader has to track which govern the whole loop and which govern each run.

### Confirmation

`packages/language/test/` pins every form of the clause token by token, its placement against the id and the settings, the output-parameter rule, the seeded variables, and what the position completes to, and the validator table in `validating.test.ts` pins the without-a-clause refusal, the `runJobPriority` refusal, and the repeatable kinds that admit the four `run` keys.
`packages/transform/test/` pins the lowering, each refusal by error class and by a substring of its message, each shadowing warning, the emitted child, the loop element's written attributes, the import back into `LoopCharacteristics`, and the printed line.
The frozen pair `tests/golden/repetition.{bpmnscript,bpmn}` carries every form of the clause across eight statements of one process and the four `run` keys on at least one repeated statement, and `tests/repetition.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/e2e/repetition.test.ts` deploys to a real Operaton and drives it over REST, offering a parallel repetition's three runs at once and a sequential one's one at a time on the same activity, ending a repetition after two runs by completion condition, driving a service task by count, binding each element of a collection in turn, never running the step inside at a count of zero, and showing `runAsyncBefore: true` make the job executor create one job per run rather than one job around the whole loop.

## More Information

The clause's fields and the four job settings are declared beside `LoopCharacteristics` in `packages/transform/src/ir/types.ts`, `runSettingKey` and `RUN_ENGINE_KEYS` beside `JOIN_KEY_BY_ENGINE_KEY` in `packages/language/src/vocabulary.ts`, and the moddle declaration in `packages/transform/src/operaton-moddle.json`.
ADR-0021 carries the per-carrier prefixing this decision reuses with a different prefix.
