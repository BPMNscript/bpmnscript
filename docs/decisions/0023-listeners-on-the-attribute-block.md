---
status: accepted
date: 2026-08-27
decision-makers: Marlon Kranz
---

# Listeners Reuse `on` Inside the Attribute Block, Not a Second Keyword

## Context and Problem Statement

Operaton runs user code at points in an element's lifecycle that are not part of the process flow.
An execution listener fires when a flow node starts or when it ends.
A task listener fires when a user task is created, assigned, completed, updated, or deleted, and a sixth event, `timeout`, fires after a timer the listener itself carries.
Either kind names its event and exactly one thing to run: a Java class, a JUEL expression, a delegate expression, or an inline script tagged with the language it is written in.
That is a four-way choice under the same exactly-one rule a service task binding already carries (ADR-0021), with an inline script where that binding has an external task topic.
A `timeout` listener's timer is the same timer definition an `on` handler and an `await` already spell with a particle clause (ADR-0017).

BPMNscript already owns the word `on`.
At statement position it catches a BPMN event: `on error "E409" { ... }` guards the enclosing body (ADR-0016), and `on Review: timer after "PT2H" { ... }` docks that same catch onto a single activity (ADR-0019).
A listener is not that.
It never appears in the diagram, it is never a node in the flow, and it fires on a lifecycle transition of the element it is written on rather than on something the process throws.
Writing it as `on create { class = "..." }` inside an attribute block hands one word two meanings that only the enclosing context tells apart.

The question this decision settles is whether the listener surface earns a keyword of its own, or reuses `on` and pays that ambiguity.
A second question rides along, because a handler statement takes an attribute block of its own and a host-less handler does not compile to a single BPMN element.
When an author writes engine attributes on an `on` handler, which of the elements that handler lowers to carries them?

## Decision Drivers

- Every keyword this language reserves is a name an author can never use for a variable or a step, which is why trigger words, binding fields, and attribute keys are soft words the validator checks rather than tokens the grammar claims (ADR-0016).
  `listener` is an ordinary English word, and a process about approvals or notifications is plausibly going to want it.
- A listener's shape is fixed by the engine and therefore checkable while the author types: a finite event set per element kind, exactly one binding out of four, a timer exactly when the event is `timeout`.
  An input or output parameter's value is the opposite case, since the keys of a map and the contents of a list are user data whose shape only the author knows, which is why that value is carried as a structure the language does not interpret.
  A bag with no declared shape is a fair carrier for the second and a forfeited diagnostic for the first.
- Whatever the compiler reads has to print back as the same model.
  A slot the printer never reaches is a silent loss on the way back, and the import contract commits this tool to warning instead of dropping (ADR-0014).
- A syntactic shape the parser already has costs less than a new one.
  The timer particle clause, the fenced script block, and the `class`, `expression`, and `delegate` keys all exist, and every reuse is one fewer form to specify, highlight, complete, and diagnose.

## Considered Options

- Reuse `on` inside the attribute block, letting position decide whether it is a listener or a caught event
- Add a distinct `listener <event> { ... }` keyword

## Decision Outcome

Chosen option: "Reuse `on` inside the attribute block", because `on` already reads as "when this happens, run that" everywhere it appears, that reading is as true of a lifecycle callback as it is of a caught error, and the alternative buys its clarity with a permanently reserved word.

The event word is a soft word, exactly like a trigger word.
`create`, `assign`, `complete`, `update`, `delete`, and `timeout` lex as ordinary identifiers, and the validator checks them against the element kind they were written on.
`start` and `end` are the exception the grammar has to name, because both are statement keywords and never lex as identifiers, so the listener's event position admits those two explicitly.

A `timeout` listener writes its timer with the particle clause unchanged.
`on timeout after "PT8H" { delegate = "${escalationHandler}" }` uses the same `after`, `at`, and `every` particles, and the same duration, date, and cycle values, as `on timer after "PT8H"` at statement position and `await timer every "R/PT1H"` inline.
The binding block holds `class`, `expression`, or `delegate` under the exactly-one rule a service task already carries, reported with the same shape of diagnostic when it is missing or doubled.
The fourth binding replaces the brace block with a fenced script, the markdown-style block whose opening tag names the language, written exactly as a `script` task's body is.
The tag is what makes that block self-describing: a script binding without a language is not executable, and the emitted `operaton:script` takes its `scriptFormat` from the tag the same way a script task's does.
Keeping the language inside the fence rather than beside it as a separate `format` key means a listener's script and a script task's script are one lexical form, so both are highlighted the same way, both stay opaque to the DSL lexer, and neither can be written without a language.

An `on` clause becomes an execution listener or a task listener by its event word alone, since the two event sets are disjoint.
On a user task, `on end` registers an execution listener and `on complete` registers a task listener, so the surface never has to spell the distinction the XML draws between `operaton:executionListener` and `operaton:taskListener`.

Engine attributes written on a handler statement land on the element that survives printing.
A hosted handler lowers to one `bpmn:boundaryEvent`, so its attribute block has one place to go and there is no choice to make.
A host-less handler lowers to two elements, a `bpmn:subProcess` carrying `triggeredByEvent="true"` and the trigger `bpmn:startEvent` nested inside it, and the attributes go on the sub-process.
A synthesized start event carries nothing, because it is elided on print: the `on <trigger>` header is built out of that start event's event definition and the start event itself produces no statement of its own, so an attribute stored there would have nowhere to be written and would be lost on the way back.
Import reads the other direction of the same rule.
Engine attributes found on an event sub-process's trigger start event are read onto that start event's own node like any other, and a start event whose block holds anything prints as an explicit `start` statement inside the handler body, which is where an author would write them back.

### Consequences

- Good, because no word is reserved.
  `listener` stays available as a step or variable name, and so do the six event words that are not already statement keywords, so a task named `create` and a variable named `timeout` still parse.
- Good, because the timer clause, the fenced script block, and the three binding keys are reused as they stand, so highlighting, completion, and the binding diagnostic extend to listeners instead of being written a second time for a second keyword.
- Good, because the binding block is its own inline block rather than the shared attribute-block fragment, so a listener cannot syntactically nest a form, an input or output parameter, or another listener.
  All three are meaningless inside a listener, and having the grammar refuse them keeps three rules out of the validator.
- Bad, because a reader has to take the enclosing context into account to know which `on` they are looking at.
  Between the braces of a `user` task it is a callback on that task; at statement position it is a catch that puts another element in the diagram.
  Nothing in the word itself says which, and an author who misplaces one gets a validation error rather than the construct they meant.
- Neutral, because every listener event the engine adds later has to be added to the validator's per-kind event set instead of arriving with the grammar, the same maintenance the soft-word design already accepted for trigger words (ADR-0016).

## Pros and Cons of the Options

### Reuse `on` inside the attribute block

`on create { class = "..." }` sits among the other members of an attribute block, between a scalar attribute and an input parameter, and is told apart from a caught event by the braces around it.

- Good, because the language names one idea once: a reader who knows what `on error` does already knows what `on create` does, which is to run something when the named thing happens.
- Good, because the timer clause and the four bindings carry over unchanged, so the listener surface is a recombination of forms that already exist rather than a new one.
- Good, because nothing is reserved, so `listener`, `create`, and `timeout` all stay available to an author who wants one of them for a step or a variable.
- Bad, because the meaning of `on` becomes positional, so a reader skimming an unfamiliar file has to look at what encloses the line before knowing what it does.

### Add a distinct `listener <event> { ... }` keyword

`listener create { class = "..." }` would name the concept outright, and every callback in a repository would be findable by searching for one word.

- Good, because there would be no ambiguity left to resolve: the word alone says the block is an engine callback rather than a node in the flow.
- Good, because it separates two things BPMN itself keeps apart, a caught event being a flow element and a listener being an extension attached to one.
- Neutral, because it would still borrow the timer clause and the binding keys, so it removes the ambiguity without giving up any of the reuse.
- Bad, because it spends a reserved word on an idea the language already has a word for, and that cost falls on every file: a process that never registers a listener still cannot call a step or a variable `listener`.
- Bad, because the distinction it buys still has to be learned, and a reader who has not learned it reads `listener` no better than a nested `on`.
  The word is the cheaper of the two to learn, since it is a token one grep turns up everywhere it is used and the positional rule is not.
  The word is paid for by every file, though, and the position only by the files that register a listener.

## More Information

The intermediate representation carries a listener as an event plus a four-way tagged binding mirroring `ServiceTaskBinding`, and a `timeout` task listener additionally carries the timer definition the event layer already models, so that timer is emitted and printed through the same code paths a caught timer uses.
Related decisions: ADR-0016 (derived event root elements, the soft-word design this event word joins), ADR-0017 (event trigger payload surfaces, the timer particle clause `timeout` reuses), ADR-0019 (boundary events attached to an activity, the hosted form whose single element fixes where its attributes go), ADR-0021 (external tasks as a service task binding, where the exactly-one-binding rule this block borrows is recorded), and ADR-0022 (engine attributes as named IR fields, the surface listeners are the nested case of).
ADR-0014 (honest BPMN import) is the standing contract behind the import side of this surface: a listener shape this surface cannot write is refused outright, and an attribute on a listener that no reader reads, such as the `id` Operaton addresses a timeout job by, is reported rather than dropped.
