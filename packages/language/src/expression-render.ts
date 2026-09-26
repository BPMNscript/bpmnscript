/**
 * Here rather than in `transform` because `astToIr` imports it and the
 * dependency runs transform -> language.
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

/** A bare `-5` parses as unary minus, but `Integer.parseInt` reads it as one integer. */
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

/** Parentheses are emitted only where the author wrote them. */
export function renderExpressionInner(node: Expr): string {
  if (isRawExpr(node)) {
    // JUEL has no `${` inside an expression, so a raw operand is spliced in by its body.
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
    // The only two escapes JUEL's `Scanner.nextString` accepts; backslash first.
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
  if (accessor.index === undefined) {
    throw new Error(
      'renderAccessor: accessor has neither a `prop` nor an `index` (unexpected accessor shape)',
    );
  }
  return `[${renderExpressionInner(accessor.index)}]`;
}

/**
 * `undefined` for a composite such as `${a} and ${b}`, which the engine
 * evaluates to text. A `}` inside a JUEL string literal is string text.
 */
export function singleTemplateBody(raw: string): string | undefined {
  if (!/^[$#]\{[^]*\}$/.test(raw)) return undefined;
  const body = raw.slice(2, -1);
  const unquoted = body.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '');
  return /\}|[$#]\{/.test(unquoted) ? undefined : body;
}
