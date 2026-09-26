---
status: accepted
date: 2026-08-30
decision-makers: Marlon Kranz
---

# Task kinds on the authoring surface

## Context and Problem Statement

Four BPMN activity tags need a statement in this grammar: `bpmn:task`, `bpmn:sendTask`, `bpmn:receiveTask`, and `bpmn:businessRuleTask`.
A document carrying a tag with no statement imports as something the printer cannot write back, so the round trip stops there.
Each of the four needs a word, and every statement keyword is a name an author can never use again.
Which four words, where do their payloads sit, and how many IR kinds do four tags need?

## Decision Drivers

- ADR-0006 binds a keyword to what the author means rather than to the BPMN element behind it.
- A statement keyword cannot be soft: `Statement` being keyword-led is what lets `start S` tell its optional trigger from the next statement.
- A Langium keyword is lexer-global, so a word spent on a statement is a variable and step name lost everywhere in a file.
- ADR-0012 refuses what changes the run and warns only about drops that do not.
- ADR-0007 models the IR on what the engine does, so a distinction the engine does not make should not become an IR kind.

## Considered Options

- `step`, `send`, `receive`, and `decide` as the four words: each says what the author is doing, three of the four are the verb itself, and the cost is four ordinary English words lost as identifiers everywhere in a file.
- `task`, `notify`, `expect`, and `rule`: `task` names the BPMN tag and nothing else, `notify` narrows a send to a notification, and `expect` and `rule` read worse than the verb beside `user` and `service`.
- The message name and the decision key in positional slots after the id: a label and a message name are both quoted strings, so an unkeyed one has no reading that position can settle.
- The message name and the decision key as settings: `call` already names its target there, and `binding` and `version` already carry the rule a decision step needs.
- One IR node for the three service-task-like tags: the discriminator is optional, so a service-task literal needs no annotation to stay valid, and the binding switch is written once.
- One IR kind per tag: it splits a shape Operaton itself does not split, and copies that binding switch through the writer, the printer, and the reader.
- A receive task with no message name in scope: the engine runs it, so there is nothing a refusal would save.
- A receive task with no message name refused on import: an error path, a message, and a test spent rejecting content the engine executes, and downgrading it to a validator warning is no cheaper, since the goldens require a decompiled document to re-validate with no diagnostic at all.

## Decision Outcome

Chosen options: `step`, `send`, `receive`, and `decide`, every payload in the settings, one IR node for the three service-task-like tags, and the nameless receive task in scope.

Sharing a word with the BPMN tag is not what ADR-0006 forbids.
`user`, `service`, and `script` already do it, and each is legal because the word means something to a reader who has never seen BPMN.
`send`, `receive`, and `decide` are the verbs an author means, and ADR-0006 names a decision as a thing a keyword should name.
`task` was rejected for the generic kind because it is the one candidate carrying no meaning beyond the tag name.

All four are hard keywords, so `step` cannot be a variable name, a bare expression identifier, an attribute key, a listener event, a form-field id, or a map key.
No source file uses any of the four, and the four rules built into a live Langium parser with Chevrotain's self-analysis on drew no ambiguity report.
`decide` sits close to `if`, which is a decision in the same vocabulary, and the two never compete for a position: `if` takes a condition and opens branches, and `decide` is a leaf activity naming a decision table.

One IR node covers `bpmn:serviceTask`, `bpmn:sendTask`, and `bpmn:businessRuleTask`.
Operaton's `BpmnParse` runs all three through `parseServiceTaskLike` when the tag carries a `class`, `expression`, `delegate`, or `topic` binding, so they share one node and an optional discriminator picks the tag.
A business rule task naming an `operaton:decisionRef` goes to `parseDmnBusinessRuleTask` instead, and the `decision` binding that form carries is the one variant `service` and `send` refuse.
A send task therefore has no message semantics of its own: the engine gives it none, and `send X(class: "...")` is what makes it send anything.

`parseReceiveTask` subscribes a receive task to a message only when `messageRef` is present, so a nameless one is a wait state the engine's signal API continues, in scope in both directions with no refusal and no warning.
A named one shares its derived `bpmn:Message` root with an `await message` of the same name.

### Consequences

- Good, because a message throw or end carries the implementation that makes the engine really send it, so this surface does not treat every thrown message as a pass-through.
  `BpmnParse` calls `isServiceTaskLike` on the `bpmn:messageEventDefinition` in both throw positions and never inspects the `endEvent` or `intermediateThrowEvent`, so the carry lives on the definition and the same attributes written on the event are inert.
- Bad, because `step` carries two senses at once: the language's word for the activity that does nothing, and the ordinary noun for any activity in a process.

### Confirmation

`packages/language/test/` and `packages/transform/test/` pin the four statements token by token, every binding rule, the import of each tag, the emitted element with its derived root, and the printed line.
The frozen pair `tests/golden/task-kinds.{bpmnscript,bpmn}` holds all four kinds, both receive forms, both decision bindings, and a message end carrying an implementation, compared byte for byte by `tests/task-kinds.round-trip.test.ts` under an import with no warning at all.
`tests/e2e/task-kinds.test.ts` deploys that process to a real Operaton, walks the token past the step, the send, and the decision, and parks it at the receive task until the message is correlated.

## More Information

Related decisions: ADR-0006 (the rule that a keyword names what the author means, and the reason `task` is not one).
ADR-0012 (the honest import contract behind every refusal and every warning here).
