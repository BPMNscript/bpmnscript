---
status: accepted
date: 2026-09-13
decision-makers: Marlon Kranz
---

# Engine settings on synthesized gateways

## Context and Problem Statement

A gateway is the one flow node in this surface with no keyword and no name of its own.
`if`, `while`, `do...while`, `parallel`, and a multi-branch `await` each synthesize one or two gateways from block structure, and the restructurer elides every one it matches back to a statement (ADR-0009, ADR-0010).
Operaton still reads five execution settings off every gateway it deploys.
`BpmnParse.parseExclusiveGateway`, `parseInclusiveGateway`, `parseParallelGateway`, and `parseEventBasedGateway` each call `parseAsynchronousContinuationForActivity` for `asyncBefore`, `asyncAfter`, and `exclusive`, and `createActivityOnScope` for `jobPriority` through `parsePriority`.
`DefaultFailedJobParseListener.parseActivity` reads the retry cycle the same way it does on an activity.
ADR-0022 gave every other flow node these five settings as named IR fields and left the four gateway kinds out, on the ground that a gateway with no textual identity has nowhere to author one.
A file a real deployment produced can set any of the five on any of its gateways, and this surface imported every one of them as a dropped extension attribute.
Where should a modeller put a setting for a construct they never write, and what should the import do with one it finds?

## Decision Drivers

- ADR-0013's rule that the compiler infers what it can rather than asking the author to spell a construct out.
- ADR-0009's elision: every gateway still has to be synthesized and matched back, so a setting cannot cost a gateway its textual anonymity.
- ADR-0014's import contract: what changes execution is refused, what does not is carried or warned, and nothing drops in silence.
- ADR-0029's one bracket shape, scalar settings in a parens, reused rather than a second shape invented for this.
- A join gateway sits beside its split under one statement, so the two need told-apart spellings inside one parens rather than a second parens.

## Considered Options

- A settings parens on the statement head, the join's settings inside it under a `join`-prefixed spelling
- A second parens for the join, separate from the head's
- A `gateway` keyword introducing an authored gateway with its own settings

## Decision Outcome

Chosen option: a settings parens on the statement head, carrying the split's five settings under their plain spelling and the join's under `join` plus the spelling, `joinAsyncBefore`, `joinAsyncAfter`, `joinExclusive`, `joinJobPriority`, `joinRetryCycle`.
One parens rather than two, because a statement already reads as one construct, and a second parens would ask an author to place a setting on a gateway they cannot see or name.

The parens sits where every other statement's settings sit: after the condition on `if` and `while`, and after the keyword on `parallel` and a multi-branch `await`, immediately before the block that follows.
On `do...while` it follows the condition as well, and there it closes the statement, since no block follows.
`if`, `parallel`, and a multi-branch `await` synthesize both a split and a join, so their head takes all ten keys, five plain and five `join`-prefixed.
`while` and `do...while` are one gateway with a back-edge, so their head takes the five plain keys alone.
A `join`-prefixed key there is an error naming the plain spelling to write instead, since there is no second gateway for it to belong to.
An `if` chain lowers to one exclusive-gateway split no matter how many `else if` branches it carries.
`lowerIf` mints a single split with one conditioned flow per branch, so the head parens govern the whole chain.
An `else if` head takes none of its own.

`parseEventBasedGateway` refuses `asyncAfter` on the gateway it deploys, so a multi-branch `await` head refuses the same setting.
The message names the branch triggers as where to put it instead, since the catch events behind the gateway are activities and take it.
The refusal repeats on import: a wait with several branches carrying `operaton:asyncAfter` throws `UnsupportedEventFeatureError` rather than importing a document that never deployed.
`joinAsyncAfter` is unaffected, since the join a race falls through to is an ordinary exclusive gateway.

A `join`-prefixed setting on a statement whose branches all terminate is a warning rather than an error.
`statementTerminates` already decides that shape for the validator's unreachable-statement check, and the compiler's `pruneUnreachableJoin` drops the join on the same condition.
The same predicate says a join setting there has nothing to act on: the join is pruned, so the setting is honest but inert.

On the way out, `irToXml` writes the four `operaton:` attributes and the `operaton:FailedJobRetryTimeCycle` child on a gateway exactly as it does on an activity.
Both go through the same `jobSettingAttrs` and `retryCycleElement` helpers, so a gateway's serialized shape is byte-identical to an activity's.
`xmlToIr` reads the same five off all four gateway tags instead of reporting each as a dropped extension attribute.
On the way to source, `irToDsl` prints the split's settings on the statement head it recovers and the join's as `join`-prefixed keys.
That happens only when the join is the one-route pass-through the restructurer elides back to the statement, exactly the shape the compiler produces and re-parses to.
A join with a second route out keeps its settings for its own head.
A gateway degraded to a jump, or otherwise left with no statement to carry them, draws a new print warning, `droppedSetting`, naming the gateway whose settings the script leaves out.
Execution listeners stay off every gateway kind: `JobSettings` carries the five settings alone, and `EngineAttributes` is the wider mixin that adds listeners for everything that keeps a textual identity to attach one to.

### Consequences

- Good, because a file a real deployment produced imports its gateway settings instead of losing them, closing the gap ADR-0022 left open.
- Good, because the settings sit where an author already looks, the statement head, rather than inventing a second parens or a keyword only for this.
- Good, because the two refusals, `asyncAfter` on a wait's head and on import, agree with each other and with what Operaton itself refuses to deploy.
- Bad, because a gateway that never reaches a statement still loses its settings on print; `droppedSetting` reports the loss rather than preventing it.
  That is an unstructured jump target, a second-route join, or a join entered from one branch alone, which prints as a guard clause.
- Bad, because ten keys now sit in one parens on three statement kinds, so a reader has to know which five are the join's before knowing which gateway a value tunes.

### Confirmation

The `gateway-settings` golden pair under `tests/golden` carries all five plain and all five join-prefixed keys, both `parallel` element kinds included, and its suite asserts the settings survive DSL to XML to DSL and back.
The validator table in `packages/language/test/validating.test.ts` pins the loop and `await` refusals and the pruned-join warning, and the import and print tables in `packages/transform/test/xml-to-ir.test.ts` and `ir-to-dsl.test.ts` pin the carry, the `asyncAfter` refusal, and `droppedSetting`.

## Pros and Cons of the Options

### A settings parens on the statement head

- Good, because it reuses the one bracket shape ADR-0029 already gives every element, at no grammar cost beyond a `SettingsParens?` slot on each of the five statement rules.
- Good, because the join's setting sits next to the split's, matching how close the two gateways sit in the model.
- Bad, because ten keys in one parens ask a reader to tell the join spellings from the split's by prefix alone.

### A second parens for the join

- Good, because the split and the join would each read as their own scalar list, with no prefix to track.
- Bad, because a statement's head would then carry two adjacent parens, a shape nothing else in the grammar does, and `while`'s single gateway would leave the second one empty for no reason.

### A `gateway` keyword

- Good, because an authored gateway could carry a setting the ordinary way any other named element does.
- Bad, because it reserves a word for an element ADR-0008 and ADR-0025 deliberately keep unauthored, and an authored gateway gains an id and stops eliding, breaking the restructurer's round trip.

## More Information

The five settings are documented beside `JobSettings` in `packages/transform/src/ir/types.ts`.
The join spellings are derived at `JOIN_KEY_BY_ENGINE_KEY` and the statements that take them are listed at `GATEWAY_STATEMENT_RULES`, both in `packages/language/src/vocabulary.ts`.

Amends ADR-0022 by dropping its rule that no engine attribute can be authored on a gateway, the rule this decision replaces.
Amends ADR-0025 by dropping its note that a multi-branch `await`'s `asyncAfter` needs no refusal, since an author can now write one.
Amends ADR-0014, whose refusal list gains the `asyncAfter` bullet for a wait with several branches.

Related decisions: ADR-0008 and ADR-0010, the synthesis and id scheme every gateway here still follows.
ADR-0029, the bracket shape reused.
