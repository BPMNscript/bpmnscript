---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Listeners Reuse `on` Inside the Attribute Block, Not a Second Keyword

## Context and Problem Statement

Operaton runs user code at points in an element's lifecycle that never appear as flow nodes.
An execution listener fires when a node starts or ends.
A task listener fires on one of several user task lifecycle events, and one of them, `timeout`, carries its own timer.
Each listener names its event and exactly one binding, a class, an expression, a delegate, or a script.
That is the same exactly-one rule a service task binding already carries (ADR-0021).

BPMNscript already uses `on` to catch a BPMN event.
`on error "E409" { ... }` guards a block (ADR-0016), and a boundary form docks that catch onto one activity (ADR-0019).
A listener is not a caught event.
It never appears in the diagram, and it fires on the element's own lifecycle rather than on something the process throws.
Writing it as `on create { class = "..." }` spells that lifecycle callback with the same word a catch uses, so one word now covers two ideas.

This decision settles whether the listener surface earns its own keyword or reuses `on` and accepts that ambiguity.
A host-less handler also lowers to two BPMN elements, so a second question follows: which one carries the engine attributes written on it?

## Decision Drivers

- Every reserved keyword is a name an author permanently loses for a variable or a step, and `listener` is a name a real process might want (ADR-0016).
- A listener's shape is fixed by the engine and checkable while typing: one event from a finite set, exactly one binding, a timer only when the event is `timeout`.
- Whatever the compiler reads has to print back as the same model, and the import contract commits this tool to warning rather than dropping what it cannot write (ADR-0014).
- The timer clause, the fenced script block, and the `class`, `expression`, and `delegate` keys exist, so reusing them costs less than specifying new forms for listeners.

## Considered Options

- Reuse `on` inside the attribute block, letting position decide whether it is a listener or a caught event
- Add a distinct `listener <event> { ... }` keyword

## Decision Outcome

Chosen option: "Reuse `on` inside the attribute block", because `on` already reads as "when this happens, run that" everywhere it appears.
The alternative buys its clarity with a permanently reserved word.

The event word is a soft word, like a trigger word.
`create`, `assign`, `complete`, `update`, `delete`, and `timeout` lex as identifiers, and the validator checks each against the element kind it was written on.
`start` and `end` lex as statement keywords instead, so the grammar names those two as the listener event position's exceptions.
A `timeout` listener writes its timer with the same particle clause as `on timer` and `await timer`, for example `on timeout after "PT8H" { delegate = "${escalationHandler}" }`.
Its binding block holds `class`, `expression`, or `delegate` under the same exactly-one rule a service task binding carries.
It can replace that block with a fenced script tagged with a language instead, exactly as a script task's body is written.
An `on` clause becomes an execution listener or a task listener by its event word alone, since the two event sets never overlap.
On a user task, `on end` registers an execution listener and `on complete` registers a task listener, so the surface never has to spell the distinction the XML draws between `operaton:executionListener` and `operaton:taskListener`.

Engine attributes on a handler statement land on the element that survives printing.
A hosted handler lowers to one `bpmn:boundaryEvent`, so there is no choice.
A host-less handler lowers to two elements instead, a `bpmn:subProcess` and a nested trigger `bpmn:startEvent`, and the attributes go on the sub-process because the synthesized start event is elided on print.

### Consequences

- Good, because no word is reserved.
- Good, because the timer clause, the script block, and the three binding keys are reused as they stand.
  Highlighting, completion, and the binding diagnostic extend to listeners for free.
- Good, because the binding block is its own inline block, not the shared attribute-block fragment.
  A listener cannot nest a form, a parameter, or another listener.
- Bad, because a reader must check the enclosing context to know which `on` they are looking at: inside a task's braces it is a callback, at statement position it is a catch.

## Pros and Cons of the Options

### Reuse `on` inside the attribute block

- Good, because the language names one idea once: `on error` and `on create` both mean "when this happens, run that."
- Good, because the timer clause and the four bindings carry over unchanged.
- Good, because nothing is reserved, so `listener`, `create`, and `timeout` stay free for a step or a variable name.
- Bad, because the meaning of `on` becomes positional, so a reader must check what encloses the line before knowing what it does.

### Add a distinct `listener <event> { ... }` keyword

- Good, because the word alone says the block is an engine callback, not a flow node.
- Good, because it keeps apart two things BPMN itself keeps apart: a caught event is a flow element, a listener is an extension on one.
- Neutral, because it would still borrow the timer clause and the binding keys.
- Bad, because it spends a reserved word on an idea the language already has a word for, and every file pays that cost whether or not it registers a listener.

## More Information

The intermediate representation carries a listener as an event plus a four-way tagged binding mirroring `ServiceTaskBinding`.
A `timeout` task listener also carries the timer the event layer already models.
Related decisions: ADR-0016 (soft words), ADR-0017 (the timer particle clause), ADR-0019 (the hosted form), ADR-0021 (the exactly-one binding rule), ADR-0022 (engine attributes as named IR fields), and ADR-0014 (the import contract this surface honors).
