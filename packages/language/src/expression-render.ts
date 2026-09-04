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

/** A {@link RawExpr} body is already a complete one and comes back verbatim. */
export function renderExpression(node: Expr): string {
  if (isRawExpr(node)) {
    return unquoteRaw(node.raw);
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
    return unquoteRaw(node.raw);
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
    return node.name + node.accessors.map(renderAccessor).join('');
  }
  if (isLiteralInt(node) || isLiteralDecimal(node)) {
    return String(node.value);
  }
  if (isLiteralString(node)) {
    // The lexer stripped the author's quotes. Re-quoting the way `juel.ts` in
    // `@bpmn-script/transform` does keeps a parse of this output idempotent.
    return `"${node.value.replace(/"/g, '\\"')}"`;
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
 * Langium auto-unquotes only the default STRING terminal, so RAW_TEMPLATE keeps
 * the author's surrounding `"` or `'`. An unquoted body passes through.
 */
function unquoteRaw(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}
