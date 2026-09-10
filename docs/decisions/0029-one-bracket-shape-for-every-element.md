---
status: accepted
date: 2026-09-06
---

# One bracket shape for every element

## Context and Problem Statement

The surface spells a value three different ways depending on where the value sits.
An engine setting takes `=` inside an attribute block, as in `user Review { assignee = "demo" }`.
A form field type and a variable type take `:`, as in `amount: number` and `var score: number`.
A label and a trigger particle take bare position, as in `start Placed "Order placed"` and `on Review timer after "PT2H" alongside`.

Nothing about an element decides which of the three applies.
An author has to remember the spelling per position rather than derive it from the shape, and the printer has to choose one per position rather than emit one form.

The same brace carries two unrelated jobs on top of that.
`{ }` holds engine settings on a task and holds the flow inside a subprocess, and a reader cannot tell which without reading the contents.

Which surface shape should every element share?

## Decision Drivers

- One rule an author can derive the next line from, rather than three rules indexed by position.
- A delimiter that says what kind of content it holds, so settings and flow are distinguishable before they are read.
- No new reserved words, since ADR-0002 puts the vocabulary in one place and ADR-0008 already fixed the grammar as structured rather than prose.
- A shape the printer can emit mechanically, because every construct round-trips through `ir-to-dsl`.
- Diff behaviour, since a process under version control is edited attribute by attribute.

## Considered Options

- Colon configuration, where `:` introduces every detail, type, value and label alike
- Brackets and blocks, where `( )` carries what an element is and `{ }` carries what runs inside it
- Keyword prose, where small words such as `is`, `means`, `assigned` and `catching` replace the punctuation
- Off-side, where indentation carries the structure and every detail is a `key: value` child
- Decorators, where each attribute is its own `@name value` line above a bare `keyword id`
- Binding form, where every element is written as an assignment, `Id = kind(name = value)`

## Decision Outcome

Chosen option: "Brackets and blocks", because it is the only option that makes the delimiter carry the distinction the three spellings were failing to make.

The shape is `verb Id(attributes) { children }`.
`( )` holds the scalar settings that describe the element.
`{ }` holds everything with internal structure, which means the flow inside a container and the member lists on a step.
An element with no members has no brace, so `user Review(label: "Review the order", assignee: "demo")` is a complete statement, and an element with no settings has no parens.

It adds no reserved words.
The `:` inside the parens is the separator the form block and the `var` declaration already use, so the change removes two of the three spellings rather than introducing a fourth.

### What the shape alone does not decide

The variant was drafted as a rendering of one process rather than as a grammar, and four of its lines do not parse unambiguously as written.
Each is settled here, because leaving any of them to the implementation would decide the language by accident.

A handler keeps the colon after its host, as in `on Pack: error(OUT_OF_STOCK, code: c)`.
Dropping it makes a hostless handler carrying a code and a hosted handler carrying none both read as `on` followed by two identifiers.
No lookahead separates those, because the trigger words are soft identifiers and the host is a cross-reference the parser cannot resolve while it is parsing.
The colon is already in the grammar for this reason, so keeping it costs nothing and settles the same question for `throw` and `emit`.

A trigger keeps its own slot, so an event-bearing element reads `verb Id trigger(payload, settings) { children }`.
The payload is positional, since `TriggerPayloadRule` gives every trigger at most one code, and a key would spell that code's role twice.
So a message names itself, `start Placed message("OrderReceived")`, and an error names its declaration, `throw error(OUT_OF_STOCK)`.
An error is raised with `throw` rather than on an end event, which ADR-0024 settled and this decision does not reopen: `throw` already lowers to a `bpmn:endEvent` carrying an `errorEventDefinition`, so an `end` spelling would be a second way to write one element.
A timer reads its bare payload as a duration, `timer("PT2H")`, and takes `at` or `every` as a key when it means a date or a cycle.
A listener's own timer clause stays positional, as in `on timeout after "PT8H"(class: "...")`, because a listener is a callback rather than an element and its parens already carry the binding that says what to run.

Form blocks, listeners, io parameters and call mappings live in the braces.
The parens carry settings that describe the element itself, and those four are lists with their own members, so they belong to the same half of the shape as flow does.
This is why `{ }` is defined above as everything with internal structure rather than as what runs: a form does not run, and forcing it into a parenthesised value would nest a listener's own settings two levels deep.

A setting with no value is written as a bare word inside the parens, as in `timer("PT2H", alongside)`.
The parens therefore hold a payload, then keyed settings, then bare flags, told apart by whether a `:` follows.

### Consequences

- Good, because an author who has seen one element can write any other, and the delimiter alone says whether a construct nests.
- Good, because the printer emits one shape rather than choosing a spelling per position, which removes a class of difference between an authored file and a generated one.
- Good, because the brace disambiguation that a settings block and a body block needed disappears; a `{` now opens children and nothing else.
- Bad, because a bare timer payload means a duration, so `timer("P1D")` and `timer(every: "P1D")` differ by a word while their strings look identical.
- Bad, because an event binding written `code: c` is no longer distinguishable by shape from a setting, so the rule that a binding declares a variable while a setting reads one moves from the grammar into the validator.
- Bad, because a lone identifier in parens is a payload rather than a flag, which `condition(ready)` needs an ordering rule to resolve rather than a shape.
- Bad, because a flag is only bare to the reader: `alongside`, `sequentially` and `local` are keywords and never lex as identifiers, so the grammar names the legal flags rather than accepting any word in that position.
- Bad, because every example, fixture and document showing the surface is respelled once, and the four TextMate grammars cannot import the vocabulary, so each needs a test that fails when it drifts.

### Confirmation

Every construct prints through `ir-to-dsl` and re-parses through the compiler, so a shape the printer emits but the parser rejects fails the suite rather than reaching a file.
The golden fixtures under `tests/golden` and the examples under `examples/spring-boot/processes` compile in the suite, so the respelling is confirmed by the same gate that confirms the language.

A handler and a listener are told apart today by which brace encloses them, and this decision puts both in the same one.
What separates them afterwards is the handler's own body block, which is mandatory where a listener has none once its settings move into the parens.
The word after `on` plays no part in it, so the parse stays unambiguous even if a trigger word and a listener event ever collide.
A collision would still leave `on <word>` meaning two things to a reader and to the validator, so the two vocabularies are held disjoint by a test rather than by the grammar.

The TextMate keyword alternation must stay equal to the grammar's reserved words, since three of the four grammars are generated or copied and are gitignored, which makes a stale artifact invisible in review.

## Pros and Cons of the Options

### Colon configuration

- Good, because there is one character to learn and nothing depends on position.
- Bad, because it is wordier than what it replaces, with every label becoming its own `label:` line.
- Bad, because the brace still carries two jobs, which leaves half the original problem in place.

### Brackets and blocks

- Good, because one shape covers every element without adding a keyword.
- Good, because the two delimiters split the two kinds of content, so nesting is visible before the content is read.
- Bad, because settings lists are longer and wrap.
- Bad, because `user Review(...)` reads like a function call rather than a step.

### Keyword prose

- Good, because it reads almost like English and forgives a reader seeing the language for the first time.
- Bad, because every added word, `is`, `means`, `assigned`, `catching`, has to be learned and spelled correctly, which trades punctuation the author can see for vocabulary the author must recall.
- Bad, because it adds reserved words to a grammar ADR-0008 kept structured on purpose.

### Off-side

- Good, because it uses the fewest separators of any option and the page stays quiet.
- Bad, because whitespace becomes meaningful, so a paste at the wrong indentation changes the model instead of failing to parse.
- Bad, because the printer has to indent exactly on the way back from BPMN, which makes every generated file a whitespace risk.

### Decorators

- Good, because the line is always `keyword id`, and one attribute per line keeps diffs clean.
- Bad, because it is read bottom-up, with the configuration before the element it belongs to.

### Binding form

- Good, because it sits closest to the data and maps onto a builder API.
- Bad, because it reads like configuration rather than a flow, and `if` and `on` stand out as foreign in it.

## More Information

The six options were drafted as full renderings of the same process, `order-handling`, so each was judged on a realistic file rather than a fragment.

Related decisions: ADR-0008 (the structured grammar this shape fills in, which decided against prose but not the bracket unification).
ADR-0030 (error and escalation codes as declared names, which fills the one payload slot this shape left holding quoted text).
ADR-0013 (the target audience, the reason the function-call reading of `user Review(...)` is a cost worth naming rather than ignoring).
ADR-0017 (the trigger payload surfaces, whose `parens` discriminator changes meaning here, since every trigger now takes parens and the field says which payload they carry).
ADR-0023 (listeners on the attribute block, whose title describes a block this decision splits).
