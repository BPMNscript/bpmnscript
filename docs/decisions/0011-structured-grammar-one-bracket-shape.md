---
status: accepted
date: 2026-06-12
decision-makers: Marlon Kranz
---

# A structured, code-like grammar with one bracket shape

## Context and Problem Statement

A BPMN DSL can expose its surface syntax in two broad shapes.
One is a flat declaration-plus-edges form: every flow node (`start`, `user`, `gateway`, `service`, `end`) is declared at the top level, and explicit `->` edges (with `when:`, `as:`, `default:`) connect them.
This maps directly to the BPMN graph model, but it reads like a diagram description rather than code, and offers little advantage over editing BPMN XML for developers who think in control-flow terms.
The other is a structured, code-like language with implicit sequence flow and block-scoped control statements.

Inside a structured surface the same question returns one level down.
An element carries an engine setting, a type, a label, a trigger payload and, for a container, a body.
If the spelling of a value follows from where the value sits rather than from the shape of the element, an author has to memorize a rule per position, and the printer has to choose one per position instead of emitting one form.
A delimiter that carries two unrelated jobs has the same effect on a reader: a brace that holds engine settings on a task and the flow inside a subprocess cannot be told apart without reading its contents.

Which surface should BPMNscript use, and which shape should every element in it share?

## Decision Drivers

- The thesis goal is a textual DSL that serves developers who prefer working in code.
- IDE support, meaning inline errors, type-aware validation, and jump-to-definition, is far richer for a real expression AST than for opaque condition strings.
- Authoring a flat graph requires the same mental model as a BPMN diagram; a structured language is closer to how developers already write sequential logic.
- The round-trip direction (BPMN XML to DSL) needs a `goto`-capable fallback for unstructured graphs, and the structured surface accommodates this naturally.
- A JUEL-subset expression sub-language parsed to a real AST is needed to enable type-check diagnostics on condition expressions.
- One rule an author can derive the next line from, rather than several rules indexed by position.
- A delimiter that says what kind of content it holds, so settings and flow are distinguishable before they are read.
- No new reserved words, since the grammar owns the vocabulary in one place.
- A shape the printer can emit mechanically, because every construct round-trips through `ir-to-dsl`.
- Diff behaviour, since a process under version control is edited attribute by attribute.

## Considered Options

- Structured code-like syntax with brackets and blocks, where keyword and braces carry implicit flow and control statements (`if`/`while`/`parallel`/`goto`), `( )` carries what an element is, and `{ }` carries what runs inside it
- A flat node/edge syntax, explicit declarations and `->` edges mapping 1:1 to the BPMN graph, which needs the same mental model as a diagram and leaves conditions as opaque strings with no expression AST behind them
- Hybrid: named blocks for common patterns, with a fallback to explicit edges
- Colon configuration, where `:` introduces every detail, type, value and label alike, needing no per-position rule but wordier, since every label becomes its own `label:` line, and still leaving the brace carrying two jobs
- Keyword prose, where small words such as `is`, `means`, `assigned` and `catching` replace the punctuation, reading close to English but trading punctuation the author can see for vocabulary to recall, and adding reserved words to a grammar kept structured on purpose
- Off-side, where indentation carries the structure and every detail is a `key: value` child, using the fewest separators but making whitespace meaningful, so a misindented paste changes the model and the printer's indentation on the way back is a risk in every generated file
- Decorators, where each attribute is its own `@name value` line above a bare `keyword id`, keeping diffs clean but read bottom-up, with the configuration before the element it belongs to
- Binding form, where every element is written as an assignment, `Id = kind(name = value)`, closest to the data and a builder API but reading like configuration rather than flow, where `if` and `on` stand out as foreign

## Decision Outcome

Chosen option: structured code-like syntax with brackets and blocks, because it matches how developers already write sequential logic, and because the two delimiters are what make a shape carry the distinction a position-indexed spelling fails to make.
Conditions become a real expression AST, which is what makes type-check diagnostics possible; `goto` slots into the same surface as the decompilation fallback for unstructured BPMN graphs.

The shape is `verb Id(attributes) { children }`.
`( )` holds the scalar settings that describe the element.
`{ }` holds everything with internal structure, which means the flow inside a container and the member lists on a step.
An element with no members has no brace, so `user Review(label: "Review the order", assignee: "demo")` is a complete statement, and an element with no settings has no parens.
It adds no reserved words, and the `:` inside the parens is the separator the form block and the `var` declaration already use.

### What the shape alone does not decide

A handler keeps the colon after its host, as in `on Pack: error(OUT_OF_STOCK, code: c)`.
Dropping it makes a hostless handler carrying a code and a hosted handler carrying none both read as `on` followed by two identifiers.
No lookahead separates those, because the trigger words are soft identifiers and the host is a cross-reference the parser cannot resolve while it is parsing.
The same colon settles the same question for `throw` and `emit`.

A trigger keeps its own slot, so an event-bearing element reads `verb Id trigger(payload, settings) { children }`.
The payload is positional, since `TriggerPayloadRule` gives every trigger at most one code, and a key would spell that code's role twice.

Form blocks, listeners, io parameters and call mappings live in the braces rather than the parens, because those four are lists with their own members, the same half of the shape as flow.
This is why `{ }` is defined above as everything with internal structure rather than as what runs: a form does not run, and forcing it into a parenthesised value would nest a listener's own settings two levels deep.

A setting with no value is written as a bare word inside the parens, as in `timer("PT2H", alongside)`.
The parens therefore hold a payload, then keyed settings, then bare flags, told apart by whether a `:` follows.

### Consequences

- Good, because the DSL reads and writes like program code (`if`/`while`/`parallel`), and an author who has seen one element can write any other.
- Good, because conditions are a first-class expression AST, enabling type-check validation and jump-to-definition for variable references.
- Good, because `parallel { { } { } }` maps directly to AND fork/join pairs, making parallel-gateway support natural to author.
- Good, because `goto` as a residual form keeps decompilation total: every valid BPMN graph has a valid DSL representation.
- Good, because the printer emits one shape rather than choosing a spelling per position, which removes a class of difference between an authored file and a generated one.
- Good, because a `{` opens children and nothing else, so the delimiter alone says whether a construct nests.
- Bad, because settings lists are longer and wrap.
- Bad, because `user Review(...)` reads like a function call rather than a step.
- Bad, because the desugaring (`astToIr`) must synthesize gateway pairs from block structure, adding complexity relative to a flat pass-through that mirrors the graph directly.
- Bad, because a bare timer payload means a duration, so `timer("P1D")` and `timer(every: "P1D")` differ by a word while their strings look identical.
- Bad, because an event binding written `code: c` is not distinguishable by shape from a setting, so the rule that a binding declares a variable while a setting reads one lives in the validator rather than in the grammar.
- Bad, because a lone identifier in parens is a payload rather than a flag, which `condition(ready)` needs an ordering rule to resolve rather than a shape.
- Bad, because a flag is only bare to the reader: `alongside`, `sequentially` and `local` are keywords and never lex as identifiers, so the grammar names the legal flags rather than accepting any word in that position.
- Bad, because the four TextMate grammars cannot import the vocabulary, so each needs a test that fails when it drifts.

### Confirmation

The construct round-trip idempotence test (`tests/round-trip-constructs.test.ts`) verifies that `if`/`else`, `while` and `parallel` survive `astToIr -> irToXml -> xmlToIr -> irToDsl` without losing structure.
The conditioned `parallel` branch and the multi-branch `await` survive the same four hops in the frozen pair `tests/golden/branch-and-race.bpmnscript` and the BPMN generated from it.
The goto-degradation path is exercised by `tests/golden/unstructured-goto.bpmn` in the same suite.
Neither the conditioned branch nor the multi-branch `await` spent a reserved word, so the grammar header's claim that there is no `gateway` keyword and that every gateway is derived from a control-flow construct holds word for word.

Every construct prints through `ir-to-dsl` and re-parses through the compiler, so a shape the printer emits but the parser rejects fails the suite rather than reaching a file.
The golden fixtures under `tests/golden` and the examples under `examples/spring-boot/processes` compile in the suite, so the surface is confirmed by the same gate that confirms the language.

A handler and a listener sit in the same brace, and what separates them is the handler's own body block, which is mandatory where a listener has none.
The word after `on` plays no part in it, so the parse stays unambiguous even if a trigger word and a listener event ever collide.
Such a collision would still leave `on <word>` meaning two things to a reader and to the validator, so the two vocabularies are held disjoint by a test rather than by the grammar.

The TextMate keyword alternation must stay equal to the grammar's reserved words, since three of the four grammars are generated or copied and are gitignored, which makes a stale artifact invisible in review.

## More Information

The JUEL-subset boundary, meaning what parses natively and what falls back to `"${...}"`, is fixed by the grammar's expression sub-rules in `packages/language/src/bpmn-script.langium` and mirrored by the hand-rolled parser in `packages/transform/src/juel.ts`.
The completion provider offers at a caret only what the validator accepts there, and `packages/language/test/completion.test.ts` holds that with a table that inserts every offered item and validates the result.
