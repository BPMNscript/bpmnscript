/**
 * Pure renderer from a parsed JUEL-subset expression AST back to its canonical
 * `${…}` body string.
 *
 * This helper lives in `packages/language` so it carries zero `transform`
 * dependencies. The desugaring `astToIr` imports `renderExpression` from
 * `@bpmn-script/language` to turn an `if`/`while` condition AST into the `${…}`
 * body stored verbatim in the IR (`conditionExpression`). It is a
 * side-effect-free tree-walk over the generated AST types — no I/O, no globals.
 *
 * Two surfaces are provided:
 *  - {@link renderExpressionInner} emits the *inner* expression text without the
 *    `${…}` wrapper (e.g. `amount > 1000`). For a {@link RawExpr} it returns the
 *    raw body verbatim (Langium has already stripped the surrounding quotes, so
 *    `"${bean.method()}"` arrives as `${bean.method()}` and is emitted as-is).
 *  - {@link renderExpression} wraps the inner text in `${…}` to produce the
 *    canonical body string the IR carries — except for a {@link RawExpr}, whose
 *    body is emitted verbatim because it is already a complete `${…}` body (or
 *    whatever the author quoted).
 *
 * The subset rendered here matches the grammar's expression sub-language
 * exactly: ternary, logical (`||`/`&&`), equality, relational, additive,
 * multiplicative, unary, parentheses, literals, and variable references with
 * dot/index accessors.
 */

import type {
  Expr,
  Accessor,
} from './generated/ast.js';
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
 * Render an expression AST node to the canonical `${…}` body string.
 *
 * For a {@link RawExpr} the raw body is returned verbatim (it is already a
 * complete `${…}` body or an author-supplied quoted form). Every other node
 * renders its inner text wrapped in `${…}`.
 *
 * @param node A parsed expression AST node (an `Expr`).
 * @returns The canonical body string, e.g. `${amount > 1000}`.
 */
export function renderExpression(node: Expr): string {
  if (isRawExpr(node)) {
    // The raw body is a complete `${…}` body. The dedicated RAW_TEMPLATE
    // terminal keeps the author's surrounding quotes (unlike the default STRING
    // terminal), so strip them here to yield the canonical unquoted body. This
    // is the escape hatch for expressions outside the parsed subset.
    return unquoteRaw(node.raw);
  }
  return `\${${renderExpressionInner(node)}}`;
}

/**
 * Render the *inner* text of an expression AST node, without the `${…}` wrapper.
 *
 * Used recursively for sub-expressions and exposed for callers that already own
 * the wrapper (or want the bare DSL surface form). Parentheses are emitted only
 * where the author wrote them (a {@link Paren} node); this is a faithful
 * structural render, not a minimal-parenthesisation pretty-printer.
 *
 * @param node A parsed expression AST node (an `Expr`).
 * @returns The bare inner expression text, e.g. `amount > 1000`.
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
    // String literals print with double quotes. The lexer stripped the
    // author's surrounding quotes, so re-quote with `"` and re-escape any
    // embedded double quote — this matches `renderNode` in
    // `@bpmn-script/transform`'s `juel.ts`, keeping the two renderers byte-
    // aligned so `parseJuel(renderExpression(x))` stays idempotent.
    return `"${node.value.replace(/"/g, '\\"')}"`;
  }
  if (isLiteralBool(node) || isLiteralNull(node)) {
    return node.value;
  }
  // Exhaustiveness guard: every `Expr` member is handled above. Reaching here
  // means a new expression node type was added without a render arm.
  const _exhaustive: never = node;
  throw new Error(
    `renderExpressionInner: unhandled expression node ${(_exhaustive as { $type?: string }).$type ?? 'unknown'}`,
  );
}

/**
 * Render a single property/index accessor (`.prop` or `[index]`).
 *
 * @param accessor A dot-property or bracket-index accessor.
 * @returns The accessor text, e.g. `.total` or `[0]`.
 */
function renderAccessor(accessor: Accessor): string {
  if (accessor.prop !== undefined) {
    return `.${accessor.prop}`;
  }
  // index access. `index` is an Expr (commonly a LiteralInt or LiteralString).
  // The grammar guarantees an accessor is `prop` XOR `index`, but TS cannot
  // prove it here; guard explicitly so a future third accessor form fails
  // loudly instead of silently rendering `undefined`.
  if (accessor.index === undefined) {
    throw new Error(
      'renderAccessor: accessor has neither a `prop` nor an `index` (unexpected accessor shape)',
    );
  }
  return `[${renderExpressionInner(accessor.index)}]`;
}

/**
 * Strip the surrounding quote characters from a {@link RawExpr.raw} body.
 *
 * The RAW_TEMPLATE terminal preserves the author's surrounding `"` or `'`
 * (Langium only auto-unquotes the default STRING terminal). A `RawExpr.raw` of
 * `"${bean.x()}"` therefore becomes `${bean.x()}`. A body that somehow arrives
 * already unquoted is returned unchanged.
 *
 * @param raw The raw template body including its surrounding quotes.
 * @returns The unquoted `${…}` body.
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
