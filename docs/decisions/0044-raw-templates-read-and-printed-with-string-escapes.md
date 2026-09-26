---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Read and print a raw template with the string escapes, either opener kept

## Context and Problem Statement

A quoted string whose body opens with `${` or `#{` is a raw template, the escape hatch for an expression outside the JUEL subset the grammar spells bare.
Langium's `DefaultValueConverter` converts only the terminal named `STRING`, so the `RAW_TEMPLATE` token reached the compiler with its quotes and escapes intact, and the reader that consumed it stripped the quotes and nothing else.
The printer's `quote()` escaped a quote and a backslash on the way out.
The two were not inverses: `"${fn(\"a\")}"` compiled to `${fn(\"a\")}`, which JUEL's `Scanner.nextEval` refuses as an invalid character, since a backslash has no meaning outside a string literal there, and every pass through the printer added one more backslash.
`renderRawFallback`, which prints an out-of-subset condition or cardinality on import, escaped nothing, so a body with a quote printed source the grammar could not lex.
Only `${` opened a raw template, so a `#{...}` body from a Camunda-authored document lexed as a literal and compiled to `${"#{x}"}`, a string the engine never evaluates, and the printer rewrote a leading `#{` to `${` wherever it could.
A raw template nested under an operator rendered as `${${x}}`, which `JuelExpressionManager.createValueExpression` rejects at deployment.
The importer refused a message or signal name opening with `${`, on the grounds that a quoted name reads back as an expression, although `BpmnParse.parseMessages` and `BpmnParse.parseSignals` evaluate every name through `createExpression` and the shape deploys.
How should a raw template be read, printed and nested, and which opener should it keep?

## Decision Drivers

- The printer's quoting and the reader's unquoting have to be exact inverses, or every round trip changes the text.
- Operaton reads `${` and `#{` the same way, in `Scanner.isEvalStart` and everywhere above it, so the surface should carry either without rewriting.
- A message name the engine evaluates is a shape ADR-0014 carries rather than refuses.

## Considered Options

- Read a raw template with the string escapes, accept either opener and print it back as written
- Keep the verbatim read, unescape at each consumption point, and rewrite `#{` to `${` on the way in
- Keep the verbatim read and stop the printer from escaping

## Decision Outcome

Chosen option: read a raw template with the string escapes, accept either opener and print it back as written, because it makes one escaper the inverse of one reader and leaves the engine's spelling alone.

`BpmnScriptValueConverter` converts a `RAW_TEMPLATE` token with `ValueConverter.convertString`, the routine `STRING` goes through, so `RawExpr.raw` holds the unquoted body with `\"`, `\\`, `\n`, `\r` and `\t` resolved.
One escaper in `packages/transform/src/juel.ts` maps those five back, and both `quote()` and `renderRawFallback` print through it.
The terminal opens on `${` or `#{`; `renderExpression` returns a top-level raw template verbatim, and `renderRawFallback` prints a raw body with the opener it was read with.
Nothing rewrites `#` to `$` except at a `bpmn:loopCardinality`, a `bpmn:completionCondition`, a `bpmn:conditionExpression`, a `bpmn:condition`, or an `operaton:errorEventDefinition` expression: a `#{...}` body the importer can spell as bare DSL prints bare there, the compiler writes it inside `${...}`, and the import reports that.
A raw template nested under an operator splices its body in parentheses, `!"${x}"` rendering `${!(x)}`, since JUEL has no `${` token inside an expression.
A composite raw template such as `"${a} and ${b}"` has no one body to splice, and the validator refuses it under an operator.
A prose value that happens to open with either opener, a label, a map key, a form value, prints with a backslash before it, `"\${..."`, which lexes as `STRING` and reads back byte for byte.
The importer carries a message or signal name opening with `${` as written; a message start keeps its refusal, since the engine rejects an expression there.

### Consequences

- Good, because printing and re-parsing a raw template gives back the same text, with a quote, a backslash or a line break inside.
- Good, because a Camunda-authored `#{...}` expression imports, compiles and deploys unchanged, in every position the surface has.
- Good, because an expression name on a message end, emit, handler start or signal imports instead of refusing a document the engine deploys.
- Bad, because a backslash inside a raw template is an escape, so `\"` reaches the engine as one character; an author who wants the engine to see a backslash writes two.
- Bad, because a structured `#{...}` body in a condition or cardinality comes back inside `${...}`; the import warns about that one rewrite.

### Confirmation

The `renderExpression` table in `packages/language/test/parsing.test.ts` pins the converter's read, both openers and the nested splice.
`packages/transform/test/juel.test.ts` re-parses every printed raw fallback through the grammar and asserts the body it reads back.
`packages/transform/test/ir-to-dsl.test.ts` pins the escaped map key, the one-line io value, the `#{` priority and form default, and `packages/transform/test/xml-to-ir.test.ts` pins the expression names that import and the five body positions that report a rewrite.

## More Information

Amends ADR-0024, whose lexical refusal of a name opening with `${` is lifted; a message start keeps the refusal ADR-0024 records for the engine's reason.
Amends ADR-0031, whose account of the raw reader stripping quotes without unescaping no longer holds; the split between `quote()` and `quoteLiteral()` it decided stands, with `quoteLiteral()` escaping either opener.

Related decisions: ADR-0014 (the import contract that carries what deploys).
