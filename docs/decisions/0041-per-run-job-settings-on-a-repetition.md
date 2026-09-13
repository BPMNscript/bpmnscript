---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# Per-run job settings on a repetition

## Context and Problem Statement

ADR-0027 gave a repeated statement the same five engine settings any other statement carries: `asyncBefore`, `asyncAfter`, `exclusive`, `jobPriority`, and `retryCycle`.
Written there, the five govern one job around the whole repetition, because Operaton reads them off the activity element itself.
`BpmnParse.parseAsynchronousContinuationForActivity` also hands a multi-instance activity's `bpmn:multiInstanceLoopCharacteristics` element to `parseAsynchronousContinuation`, so the same three async settings written there mean one job per run instead.
`DefaultFailedJobParseListener.parseActivity` reads a retry cycle off that element the same way.
`createActivityOnScope` reads a job priority off the activity element alone, and nothing in the engine reads one off the loop element.
A document a real deployment produced could carry any of the four on its loop element.
This surface refused every one of them on import, since ADR-0027 gave the clause nowhere to write what the document already ran with.
Where does a per-run job setting sit on this surface, and what should happen to a per-run job priority the engine reads nowhere?

## Decision Drivers

- The language README's Repetition section already named the gap, as it stood: "one job per run is a setting on the multi-instance element itself, which this surface has nowhere to write."
  Closing it is this decision's whole purpose.
- ADR-0029's one bracket shape holds every scalar setting in a parens on the statement head; a second construct for four more settings needs its own justification.
- ADR-0040 already solved the same shape of problem for a join gateway's settings, deriving a second spelling from the plain one with `prefixedSettingKey`.
- ADR-0014's import contract: a document a real deployment produced should import back rather than refuse, whenever this surface can honestly carry what it wrote.

## Considered Options

- Four keys in the statement's own parens, prefixed `run`
- A second parens attached to the `for` clause itself
- The four settings spelled inside the clause's own grammar

## Decision Outcome

Chosen option: four keys in the statement's own parens, prefixed `run`.

`runAsyncBefore`, `runAsyncAfter`, `runExclusive`, and `runRetryCycle` sit in the same parens a repeated statement's own five settings already occupy.
Each is spelled by `runSettingKey(key) = prefixedSettingKey('run', key)`, the exact function ADR-0040's join spellings already use with a different prefix.
No `runJobPriority` exists, because `createActivityOnScope` reads a job priority off the activity element alone.
Nothing in the engine ever looks at the loop element for one, so a value written there would be honored by nothing.
The validator refuses that specific spelling by name rather than folding it into the generic unknown-key message.
A generic "not valid on a service task" would send an author hunting for a spelling that does not exist.
None of the nine repeatable statement kinds also synthesizes a gateway, and none of the three statements that synthesize a join repeats.
A `run`-prefixed key and a `join`-prefixed key therefore never both sit in one parens.
A `run*` key on a statement with no `for` clause is an error naming the fix: one job per run says nothing coherent when there is no run.
The message also names the plain spelling to write instead, for one job around the step.

The four fields land flat on `LoopCharacteristics`, typed `Omit<JobSettings, 'jobPriority'>`, so the loop object is `JobSettings`-shaped everywhere but that one field.
ADR-0027's `readLoop` in `ast-to-ir.ts` reads them with `readJobSettings(settingsOf(stmt.items), runSettingKey)`, the same reader every other job-setting owner already uses, just keyed by the prefixed function instead of the identity one.
`jobSettingAttrs(loop)` and `retryCycleElement(moddle, loop)` in `ir-to-xml.ts` write the loop element's four attributes and its `operaton:FailedJobRetryTimeCycle` child exactly as they write an activity's.
Both take a plain `JobSettings`-shaped argument, and neither reads the DSL spelling at all.
On the XML side the loop element carries the plain, unprefixed attribute names, `operaton:asyncBefore` and not a `run`-prefixed one.
The loop element is already its own element, distinct from the activity's, so nothing there needs disambiguating the way one shared parens does.
Only the DSL surface needs the `run` prefix, since the split's settings and the loop's share one parens on the same statement.
The moddle declaration makes the plain names legal and typed on that element in the first place: `AsyncCapable.extends` in `operaton-moddle.json` gains `bpmn:MultiInstanceLoopCharacteristics` beside `bpmn:FlowNode`.
Upstream camunda-bpmn-moddle already declares the same properties there through `Collectable`'s own superclass.
Before this, the loop element's `asyncBefore` and friends parsed into `$attrs` as untyped strings, invisible to every typed reader ADR-0040 built.

On import, `readRunSettings` in `xml-to-ir.ts` reads the same four plain attribute names and the retry-cycle child off the loop element, the same shape `readJobSettings` reads off any other owner.
`sweepRepetition` keeps its existing warning naming `operaton:jobPriority` on the loop element, since the engine still never reads one there.
On the way to source, `jobSettingItems(el.loop, runSettingKey)` in `irToDsl`'s `engineSettings` prints the four beside the statement's own settings, guarded by `repeats(el.loop)`.
A loop with nothing to repeat over carries none by construction, and prints none.

### Consequences

- Good, because a document a real deployment produced, carrying async or retry settings on its multi-instance element, now imports rather than refusing, closing the gap the language README named.
- Good, because no new IR shape was needed: `LoopCharacteristics` already existed, and every read, write, import, and print helper ADR-0040 built for `JobSettings` applies to it unchanged, keyed by a different function.
- Bad, because a repeated statement's parens can now hold nine keys, five plain and four `run`-prefixed.
  A reader has to track which five govern the whole repetition and which four govern each run, the same trade ADR-0040 already accepted for a gateway's ten.
- Neutral, because `jobPriority` in that same parens keeps exactly one meaning, the whole repetition, since `createActivityOnScope` reads it off the step regardless of what repeats around it.
  There is no ambiguity, only a spelling an author might expect and not find.

### Confirmation

The `repetition` golden pair under `tests/golden` carries the four `run` keys on at least one repeated statement, and its round-trip suite asserts the settings survive DSL to XML to DSL unchanged.
The validator table in `packages/language/test/validating.test.ts` pins the without-a-clause refusal, the `runJobPriority` refusal, and the nine repeatable kinds that admit the four.
The transform suites pin the loop element's written attributes, the import back into `LoopCharacteristics`, and the printed keys.
The end-to-end suite deploys a repeated step with `runAsyncBefore: true` and asserts the job executor creates one job per run rather than one job around the whole loop.

## Pros and Cons of the Options

### Four keys in the statement's own parens, prefixed `run`

- Good, because it reuses the one bracket shape ADR-0029 already gives every element, at no grammar cost.
- Good, because it reuses the exact derivation ADR-0040's join spellings already use, so the validator, the printer, and the importer read one function for both prefixes.
- Bad, because it grows the parens on a repeated statement to nine keys at once, five plain and four prefixed.

### A second parens attached to the `for` clause

- Good, because a run's settings would sit visually next to the clause that creates the runs, rather than mixed in with the whole step's own settings.
- Bad, because it is a second bracket shape ADR-0029 exists specifically to avoid, one grammar rule and one printer branch for four settings that already have a home elsewhere.

### The four settings spelled inside the clause's own grammar

- Good, because visual adjacency to the clause is the same as the option above.
- Bad, because the `for` clause is a phrase grammar, not a keyed settings list.
  Folding four settings into it needs new syntax for each one, where the settings-key list already reuses machinery built for every other element.

## More Information

The four fields are declared beside `LoopCharacteristics` in `packages/transform/src/ir/types.ts`.
`runSettingKey` and `RUN_ENGINE_KEYS` are declared beside `JOIN_KEY_BY_ENGINE_KEY` in `packages/language/src/vocabulary.ts`.
The moddle declaration is in `packages/transform/src/operaton-moddle.json`.

Amends ADR-0027, closing the gap the language README's Repetition section named.
Amends ADR-0014, whose `UnsupportedLoopCharacteristicsError` bullet no longer refuses an async or retry setting on the repetition element itself.

Related decisions: ADR-0010 (the deterministic ids a repeated activity keeps).
ADR-0022 (engine attributes as named IR fields, the convention this decision extends onto a second element).
ADR-0029 (the one bracket shape reused here).
ADR-0040 (the same per-carrier prefixing convention, reused with a different prefix).
