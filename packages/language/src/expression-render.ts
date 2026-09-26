/**
 * Renders a parsed JUEL-subset expression back to its `${...}` text. It lives
 * here rather than in `transform` because `astToIr` imports it; the dependency
 * runs transform -> language and never the reverse.
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
 * The digits of an integer literal with its sign, else `undefined`. A bare
 * `-5` parses as a `-` unary over `5`, and every setting the engine reads with
 * `Integer.parseInt` or `Long.parseLong` takes it as one integer, not an
 * expression.
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

export function renderExpression(node: Expr): string {
  if (isRawExpr(node)) {
    return node.raw;
  }
  return `\${${renderExpressionInner(node)}}`;
}

/** The text inside the `${...}` wrapper. Parentheses are emitted only where the author wrote them. */
export function renderExpressionInner(node: Expr): string {
  if (isRawExpr(node)) {
    // JUEL has no `${` token inside an expression, so a raw operand is spliced
    // in by its body; a composite has no one body and is left for the
    // validator to refuse.
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
    // JUEL text, so the backslash is doubled before the quote is escaped, as
    // `escapeQuoted` in `@bpmn-script/transform`'s `juel.ts` does: those are
    // the only two escapes operaton-juel's `Scanner.nextString` accepts.
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
  // The grammar guarantees `prop` XOR `index`, which TS cannot prove here.
  if (accessor.index === undefined) {
    throw new Error(
      'renderAccessor: accessor has neither a `prop` nor an `index` (unexpected accessor shape)',
    );
  }
  return `[${renderExpressionInner(accessor.index)}]`;
}

/**
 * The body of a raw template that is exactly one template, else `undefined`:
 * `${a} and ${b}` and `${a} b}` are composites the engine evaluates to text
 * around the template. A `}` or opener inside a JUEL string literal is string
 * text (`Scanner.nextString`), so `${map['}']}` is one template.
 */
export function singleTemplateBody(raw: string): string | undefined {
  if (!/^[$#]\{[^]*\}$/.test(raw)) return undefined;
  const body = raw.slice(2, -1);
  const unquoted = body.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');
  return /\}|[$#]\{/.test(unquoted) ? undefined : body;
}
