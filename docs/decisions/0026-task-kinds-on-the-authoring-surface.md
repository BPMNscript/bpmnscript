---
status: accepted
date: 2026-08-30
decision-makers: Marlon Kranz
---

# Task Kinds on the Authoring Surface: `step`, `send`, `receive`, and `decide`

## Context and Problem Statement

Four BPMN activity tags have no statement in this grammar: `bpmn:task`, `bpmn:sendTask`, `bpmn:receiveTask`, and `bpmn:businessRuleTask`.
A document carrying one imports as something the printer cannot write back, so the round trip stops there.
Each of the four needs a word, and every statement keyword is a name an author can never use again.
Which four words, where do their payloads sit, and how many IR kinds do four tags need?

## Decision Drivers

- ADR-0013 binds a keyword to what the author means rather than to the BPMN element behind it.
- A statement keyword cannot be soft: `Statement` being keyword-led is what lets `start S` tell its optional trigger from the next statement.
- A Langium keyword is lexer-global, so a word spent on a statement is a variable and step name lost everywhere in a file.
- ADR-0014 refuses what changes the run and warns only about drops that do not.
- ADR-0006 models the IR on what the engine does, so a distinction the engine does not make should not become an IR kind.

## Considered Options

- `step`, `send`, `receive`, and `decide` as the four words
- `task`, `notify`, `expect`, and `rule`
- The message name and the decision key in positional slots after the label
- The message name and the decision key in the settings block
- One IR node for the three service-task-like tags
- One IR kind per tag
- A receive task with no message name in scope
- A receive task with no message name refused on import

## Decision Outcome

Chosen options: `step`, `send`, `receive`, and `decide`, every payload in the settings block, one IR node for the three service-task-like tags, and the nameless receive task in scope.

Sharing a word with the BPMN tag is not what ADR-0013 forbids.
`user`, `service`, and `script` already do it, and each is legal because the word means something to a reader who has never seen BPMN.
`send`, `receive`, and `decide` are the verbs an author means, and ADR-0013 names a decision as a thing a keyword should name.
`task` was rejected for the generic kind because it is the one candidate carrying no meaning beyond the tag name.

All four are hard keywords, so `step` stops being a variable name, a bare expression identifier, an attribute key, a listener event, a form-field id, and a map key.
No existing file uses any of the four, and the four rules built into a live Langium parser with Chevrotain's self-analysis on drew no ambiguity report.

`decide` sits close to `if`, which is a decision in the same vocabulary.
It is accepted because the two never compete for a position: `if` takes a condition and opens branches, and `decide` is a leaf activity naming a decision table.

Every payload sits in the settings block rather than in a slot after the label, as in `receive AwaitSettlement "Wait for the payment" { message = "PaymentSettled" }`.
A label and a message name are both quoted strings in the same slot, so `receive R "X"` has no reading that position can settle.
The block also brings reuse, since `call` already names its target there, and `binding` and `version` already carry the rule a decision step needs.

One IR node covers `bpmn:serviceTask`, `bpmn:sendTask`, and `bpmn:businessRuleTask`.
Operaton's `BpmnParse` runs all three through `parseServiceTaskLike` when the tag carries a `class`, `expression`, `delegate`, or `topic` binding, so they share one node and an optional discriminator picks the tag.
A business rule task naming an `operaton:decisionRef` goes to Operaton's `parseDmnBusinessRuleTask` instead, and the `decision` binding that form carries is the one variant `service` and `send` refuse.
A send task therefore has no message semantics of its own: the engine gives it none, and `send X { class = "..." }` is what makes it send anything.

A receive task with no message name is in scope in both directions, with no refusal and no warning, as in `receive AwaitPickingSlot "Wait for a picking slot"`.
Operaton's `parseReceiveTask` subscribes a receive task to a message only when `messageRef` is present, so a nameless one is a wait state the engine's signal API continues.
A named one derives its `bpmn:Message` root through the collector ADR-0016 already uses, so it shares that root with an `await message` of the same name.

A decision step pins its table with `binding = latest`, `binding = deployment`, or `version = 3`, the call activity's surface reused down to the validator rule and the IR type.

### Consequences

- Good, because a message throw or end may now carry the implementation that makes the engine really send it, so this surface no longer treats every thrown message as a pass-through.
  ADR-0024 refused such a document on import, and that refusal was aimed at the wrong element.
  Operaton's `BpmnParse` calls `isServiceTaskLike` on the `bpmn:messageEventDefinition` in both throw positions and never inspects the `endEvent` or `intermediateThrowEvent`.
  The same attributes written on the event are therefore inert, so the refusal rejected content the engine ignores.
  The carry now lives on the definition, and an implementation on the event warns.
- Bad, because `operaton:resultVariable` on a thrown message's definition warns away while the binding beside it imports, and Operaton fills it from an `expression` binding's return value.
  Operaton rejects the deployment outright when a `class` or `delegateExpression` binding carries one, so the expression form is the only one that loses anything.
  It is a warned execution change where ADR-0014 asks for a refusal, recorded here as a deliberate boundary rather than left unstated.
- Bad, because `step` now carries two senses at once: the language's word for the activity that does nothing, and the ordinary noun for any activity in a process.

### Confirmation

`packages/language/test/` and `packages/transform/test/` pin the four statements token by token, every binding rule, the import of each tag, the emitted element with its derived root, and the printed line.
The frozen pair `tests/golden/task-kinds.{bpmnscript,bpmn}` holds all four kinds, both receive forms, both decision bindings, and a message end carrying an implementation.
`tests/task-kinds.round-trip.test.ts` compares the compiled XML byte for byte and requires an import with no warning at all.
`tests/e2e/task-kinds.test.ts` deploys that process to a real Operaton, walks the token past the step, the send, and the decision, and parks it at the receive task until the message is correlated.

## Pros and Cons of the Options

### `step`, `send`, `receive`, and `decide`

- Good, because each word says what the author is doing, which is the test ADR-0013 sets, and three of the four are the verb itself.
- Bad, because four ordinary English words stop being available as identifiers anywhere in a file.

### `task`, `notify`, `expect`, and `rule`

- Bad, because `task` names the BPMN tag and nothing else, `notify` narrows a send to a notification, and `expect` and `rule` read worse than the verb beside `user` and `service`.

### One IR node for the three service-task-like tags

- Good, because the discriminator is optional, so every existing service-task literal in the sources and the test suites stays valid untouched, and the binding switch is written once.

### One IR kind per tag

- Bad, because it splits a shape Operaton itself does not split, and copies that binding switch through the writer, the printer, and the reader.

### A receive task with no message name refused

- Bad, because it costs an error path, a message, and a test to reject content the engine executes, which ADR-0014 reserves for shapes that change the run.
- Bad, because downgrading it to a validator warning is no cheaper: the goldens require a decompiled document to re-validate with no diagnostic at all.

## More Information

Supersedes the paragraph in ADR-0024 recording a thrown message's send implementation as refused on import, since this surface now carries it.
Related decisions: ADR-0013 (the rule that a keyword names what the author means, and the reason `task` is not one).
ADR-0014 (the honest import contract behind every refusal and every warning here).
ADR-0016 (the derived `bpmn:Message` roots a named receive task joins).
ADR-0021 (the service-task binding set the send task, the decision step, and the message throw all reuse).
ADR-0024 (the message end and message throw this decision gives an implementation).
