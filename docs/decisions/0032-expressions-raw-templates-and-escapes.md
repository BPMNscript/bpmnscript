---
status: accepted
date: 2026-09-14
decision-makers: Marlon Kranz
---

# Expressions: raw templates, escapes, and what is lowered as EL

## Context and Problem Statement

A quoted string whose body opens with `${` or `#{` is a raw template, the escape hatch for an expression outside the JUEL subset the grammar spells bare.
Its body reaches the engine as expression text, so the reader that unquotes the token and the printer that quotes it back have to be exact inverses, or a compile and a decompile change what the engine evaluates.
Imported documents carry both openers, and a quoted body may hold a quote, a backslash or a line break.
How is a raw template read, printed and nested, and which opener does it keep?

## Decision Drivers

- The printer's quoting and the reader's unquoting have to be exact inverses, or every round trip changes the text.
- Operaton reads `${` and `#{` the same way, in `Scanner.isEvalStart` and everywhere above it, so the surface should carry either without rewriting.
- A backslash has no meaning outside a string literal in JUEL, where `Scanner.nextEval` refuses one as an invalid character.
- A message name the engine evaluates is a shape ADR-0012 carries rather than refuses.

## Considered Options

- Read a raw template with the string escapes, accept either opener and print it back as written, which makes one escaper the inverse of one reader and leaves the engine's spelling alone.
- Read the token verbatim, unescape at each consumption point, and rewrite `#{` to `${` on the way in, which spreads the inverse over every consumption point and changes text the engine evaluates identically either way.
- Read the token verbatim and stop the printer from escaping, which loses a quote, a backslash or a line break inside a body on the way back out.

## Decision Outcome

Chosen option: read a raw template with the string escapes, accept either opener and print it back as written, because it makes one escaper the inverse of one reader and leaves the engine's spelling alone.

`BpmnScriptValueConverter` converts a `RAW_TEMPLATE` token with `ValueConverter.convertString`, the routine `STRING` goes through, so `RawExpr.raw` holds the unquoted body with `\"`, `\\`, `\n`, `\r` and `\t` resolved.
One escaper in `packages/transform/src/juel.ts` maps those five back, and both `quote()` and `renderRawFallback` print through it.
Moving a slot from `quote()` to `quoteLiteral()` is a behaviour change rather than a refactor, and needs a decision of its own: settings still on `quote()`, such as a topic or a decision reference, can legitimately hold an expression in Operaton, so reclassifying one changes what a recompiled document runs.
The terminal opens on `${` or `#{`; `renderExpression` returns a top-level raw template verbatim, and `renderRawFallback` prints a raw body with the opener it was read with.
A raw template nested under an operator splices its body in parentheses, `!"${x}"` rendering `${!(x)}`, since JUEL has no `${` token inside an expression and `JuelExpressionManager.createValueExpression` rejects `${${x}}` at deployment.
A composite raw template such as `"${a} and ${b}"` has no one body to splice, and the validator refuses it under an operator.
A prose value that happens to open with either opener, a label, a map key, a form value, goes through `quoteLiteral()`, which puts a backslash before it, `"\${..."`, so the value lexes as `STRING` and reads back byte for byte.
The importer carries a message or signal name opening with `${` as written, since `BpmnParse.parseMessages` and `BpmnParse.parseSignals` evaluate every name through `createExpression` and the shape deploys; a message start keeps its refusal, since the engine rejects an expression there.

### Consequences

- Good, because printing and re-parsing a raw template gives back the same text, with a quote, a backslash or a line break inside.
- Good, because a Camunda-authored `#{...}` expression imports, compiles and deploys unchanged, in every position the surface has.
- Good, because an expression name on a message end, emit, handler start or signal imports instead of refusing a document the engine deploys.
- Bad, because a backslash inside a raw template is an escape, so `\"` reaches the engine as one character; an author who wants the engine to see a backslash writes two.
- Bad, because a structured `#{...}` body in a condition or cardinality comes back inside `${...}`; the import warns about that one rewrite.

### Confirmation

The `renderExpression` table in `packages/language/test/parsing.test.ts` pins the converter's read, both openers and the nested splice, and `packages/transform/test/juel.test.ts` re-parses every printed raw fallback through the grammar and asserts the body it reads back.
`packages/transform/test/ir-to-dsl.test.ts` pins the escaped map key, the one-line io value, the `#{` priority and form default, and `packages/transform/test/xml-to-ir.test.ts` pins the expression names that import and the five body positions that report a rewrite.
