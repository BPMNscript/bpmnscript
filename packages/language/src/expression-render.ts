/**
 * Renders a parsed JUEL-subset expression AST back to its canonical `${...}`
 * body string. It lives here rather than in `transform` so it carries no
 * dependency on that package; `astToIr` imports it the other way round.
 */

import type { Expr, Accessor } from './generated/ast.js';
import {
  isAdditive,
  isEquality,
  isLiteralBool,
  isLiteralDecimal,
  isLiteralInt,
  isLiteralNull,
  isLiteralString,
  isLogical,
  isMultiplicative,
  isParen,
  isRawExpr,
  isRelational,
  isTernary,
  isUnary,
  isVarRef,
} from './generated/ast.js';

/**
 * The digits of an integer literal with its sign, or `undefined` for any other
 * expression. Bare, `-5` parses as a `-` unary over `5`, and every setting the
 * engine reads with `Integer.parseInt` or `Long.parseLong` takes that as the
 * one integer it is rather than as an expression.
 */
export function integerLiteralText(node: Expr): string | undefined {
  if (isLiteralInt(node)) {
    return String(node.value);
  }
  if (isUnary(node) && node.op === '-' && isLiteralInt(node.operand)) {
    return `-${node.operand.value}`;
  }
  return undefined;
}

/** A {@link RawExpr} is already a complete `${...}` or `#{...}` and comes back as written. */
export function renderExpression(node: Expr): string {
  if (isRawExpr(node)) {
    return node.raw;
  }
  return `\${${renderExpressionInner(node)}}`;
}

/**
 * The inner text without the `${...}` wrapper. Parentheses are emitted only
 * where the author wrote them: a faithful structural render, not a
 * minimal-parenthesization printer.
 */
export function renderExpressionInner(node: Expr): string {
  if (isRawExpr(node)) {
    // JUEL has no `${` token once inside an expression, so a raw operand is
    // spliced in by its body. A composite raw has no one body to splice and is
    // left as written for the validator to refuse.
    const body = singleTemplateBody(node.raw);
    return body === undefined ? node.raw : `(${body})`;
  }
  if (isTernary(node)) {
    return (
      `${renderExpressionInner(node.condition)} ? ` +
      `${renderExpressionInner(node.whenTrue)} : ` +
      `${renderExpressionInner(node.whenFalse)}`
    );
  }
  // All five binary precedence levels share the same `left op right` shape.
  if (
    isLogical(node) ||
    isEquality(node) ||
    isRelational(node) ||
    isAdditive(node) ||
    isMultiplicative(node)
  ) {
    return `${renderExpressionInner(node.left)} ${node.op} ${renderExpressionInner(node.right)}`;
  }
  if (isUnary(node)) {
    return `${node.op}${renderExpressionInner(node.operand)}`;
  }
  if (isParen(node)) {
    return `(${renderExpressionInner(node.inner)})`;
  }
  if (isVarRef(node)) {
    return node.ref.$refText + node.accessors.map(renderAccessor).join('');
  }
  if (isLiteralInt(node) || isLiteralDecimal(node)) {
    return String(node.value);
  }
  if (isLiteralString(node)) {
    // The lexer stripped the author's quotes. This produces JUEL text, so it
    // must double the backslash before escaping the quote, same as `juel.ts`
    // in `@bpmn-script/transform` does: those are the only two escapes
    // operaton-juel's `Scanner.nextString` accepts.
    return `"${node.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (isLiteralBool(node) || isLiteralNull(node)) {
    return node.value;
  }
  const _exhaustive: never = node;
  throw new Error(
    `renderExpressionInner: unhandled expression node ${(_exhaustive as { $type?: string }).$type ?? 'unknown'}`,
  );
}

function renderAccessor(accessor: Accessor): string {
  if (accessor.prop !== undefined) {
    return `.${accessor.prop}`;
  }
  // The grammar guarantees `prop` XOR `index`, which TS cannot prove here;
  // guard so a third accessor form throws instead of rendering `undefined`.
  if (accessor.index === undefined) {
    throw new Error(
      'renderAccessor: accessor has neither a `prop` nor an `index` (unexpected accessor shape)',
    );
  }
  return `[${renderExpressionInner(accessor.index)}]`;
}

/**
 * The body of a raw template that is exactly one template, `${body}` or
 * `#{body}` with no second opener and no `}` before the last, else
 * `undefined`: `${a} and ${b}` and `${a} b}` are composites the engine
 * evaluates to text around the one template each holds. A `}` or opener
 * inside a JUEL string literal is string text (`Scanner.nextString`), so
 * `${map['}']}` is one template.
 */
export function singleTemplateBody(raw: string): string | undefined {
  if (!/^[$#]\{[^]*\}$/.test(raw)) return undefined;
  const body = raw.slice(2, -1);
  const unquoted = body.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');
  return /\}|[$#]\{/.test(unquoted) ? undefined : body;
}
