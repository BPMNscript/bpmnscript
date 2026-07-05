/**
 * Standalone JUEL-subset expression parser, classifier, and DSL serializer
 * (transform side).
 *
 * On the **import** path, `xmlToIr` reads raw `${…}` expression bodies
 * out of BPMN XML; `irToDsl` renders them back to BPMNscript surface
 * syntax. This module is the hinge between the two: it decides whether a body
 * fits the JUEL native subset — and can therefore be emitted as clean
 * unquoted DSL — or must fall back to the quoted `"${…}"` raw form.
 * {@link parseJuel} never throws on arbitrary input.
 *
 * The subset boundary is fixed by the Langium expression sub-grammar
 * (`packages/language/src/bpmn-script.langium`):
 *
 *   ternary  →  c ? t : f
 *   logical  →  ||  &&
 *   equality →  ==  !=
 *   relational → <=  >=  <  >
 *   additive →  +  -
 *   multiplicative → *  /  %
 *   unary    →  !x  -x
 *   primary  →  int | decimal | string | bool | null
 *            |  varRef (id with `.prop` / `[expr]` accessors)
 *            |  ( expr )
 *
 * Anything beyond this — method/bean calls (`x.foo()`), JUEL functions
 * (`fn:size(x)`), parenthesised call syntax, or any malformed body — is
 * classified **raw**. The hand-rolled recursive-descent parser below mirrors
 * the grammar's precedence and accept/reject set exactly; the test suite
 * cross-checks parity against the real Langium grammar so the two cannot drift.
 *
 * Why hand-rolled rather than re-invoking the Langium parser: the subset is
 * small and fixed, and a
 * dependency-free synchronous parser keeps `xmlToIr`/`irToDsl` free of the
 * language package's async parse machinery on the hot import path. Subset
 * parity is guaranteed by an explicit cross-check test, not by sharing code.
 *
 * Canonical surface form (shared with `renderExpression` in
 * `@bpmn-script/language`): string literals print with double quotes; operators
 * are spaced (`a > b`); accessors are `.prop` / `[idx]`; author parentheses are
 * preserved. This shared notion makes `parseJuel(renderExpression(x))`
 * idempotent on the subset.
 */

/** A parsed expression node within the JUEL native subset. */
export type JuelNode =
  | { kind: 'int'; value: number }
  | { kind: 'decimal'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: 'true' | 'false' }
  | { kind: 'null' }
  | { kind: 'varRef'; name: string; accessors: Accessor[] }
  | { kind: 'unary'; op: '!' | '-'; operand: JuelNode }
  | { kind: 'binary'; op: BinaryOp; left: JuelNode; right: JuelNode }
  | {
      kind: 'ternary';
      condition: JuelNode;
      whenTrue: JuelNode;
      whenFalse: JuelNode;
    }
  | { kind: 'paren'; inner: JuelNode };

/** A property (`.prop`) or index (`[expr]`) accessor on a variable reference. */
export type Accessor = { prop: string } | { index: JuelNode };

/** Binary operators across all five precedence levels of the subset. */
export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<='
  | '>='
  | '<'
  | '>'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

/**
 * The outcome of {@link parseJuel}: either a structured subset AST, or a raw
 * fallback carrying the verbatim inner body (without the `${…}` wrapper).
 */
export type ExprResult =
  | { kind: 'structured'; expr: JuelNode }
  | { kind: 'raw'; text: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a BPMN `${…}` expression body against the JUEL native subset.
 *
 * Strips a single leading `${` and trailing `}`, then attempts to parse the
 * inner text as a subset expression. On success returns
 * `{ kind: 'structured', expr }`; on any failure — a body that does not match
 * the `${…}` shape, contains method/bean calls, JUEL functions, or is otherwise
 * unparseable — returns `{ kind: 'raw', text }` with the verbatim inner body.
 * This function never throws.
 *
 * @param body A BPMN expression body, e.g. `${amount > 1000}`.
 * @returns A structured or raw {@link ExprResult}.
 */
export function parseJuel(body: string): ExprResult {
  const inner = stripWrapper(body);
  if (inner === undefined) {
    // Not a `${…}` body — fall back to the verbatim (best-effort) inner text.
    return { kind: 'raw', text: stripWrapperLenient(body) };
  }
  try {
    const tokens = tokenize(inner);
    if (tokens === undefined) {
      return { kind: 'raw', text: inner };
    }
    const parser = new Parser(tokens);
    const expr = parser.parseExpr();
    // The parse must consume the entire token stream; trailing tokens (such as
    // the `()` of a method call) mean the body is outside the subset.
    if (!parser.atEnd()) {
      return { kind: 'raw', text: inner };
    }
    return { kind: 'structured', expr };
  } catch {
    // Any parse error → raw.
    return { kind: 'raw', text: inner };
  }
}

/**
 * Render an {@link ExprResult} to its DSL surface string.
 *
 * Structured results render as a bare, unquoted expression (`amount > 1000`).
 * Raw results render as the quoted `"${…}"` fallback so the original body
 * survives round-trip verbatim. This is the form `irToDsl` writes into
 * a condition or attribute position.
 *
 * @param result A parsed {@link ExprResult}.
 * @returns The DSL surface string.
 */
export function renderRawFallback(result: ExprResult): string {
  if (result.kind === 'raw') {
    return `"\${${result.text}}"`;
  }
  return renderNode(result.expr);
}

// ---------------------------------------------------------------------------
// `${…}` wrapper handling
// ---------------------------------------------------------------------------

/**
 * Strip exactly one leading `${` and one trailing `}` from a body.
 *
 * Returns the inner text on success, or `undefined` when the body does not have
 * the `${…}` shape (so the caller can route it to the raw fallback).
 */
function stripWrapper(body: string): string | undefined {
  const trimmed = body.trim();
  if (
    trimmed.startsWith('${') &&
    trimmed.endsWith('}') &&
    trimmed.length >= 3
  ) {
    return trimmed.slice(2, -1);
  }
  return undefined;
}

/**
 * Best-effort inner-text extraction for a body that failed {@link stripWrapper}.
 * Used only to populate the `text` of a raw result, so the value is informative
 * even for a malformed body; it never affects classification.
 */
function stripWrapperLenient(body: string): string {
  const trimmed = body.trim();
  let s = trimmed;
  if (s.startsWith('${')) {
    s = s.slice(2);
  }
  if (s.endsWith('}')) {
    s = s.slice(0, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenType =
  | 'int'
  | 'decimal'
  | 'string'
  | 'id'
  | 'bool'
  | 'null'
  | 'op'
  | 'punct';

interface Token {
  type: TokenType;
  /** Raw text for `op`/`punct`; the decoded value for literals/identifiers. */
  value: string;
  /** For string tokens: the decoded (unescaped) string content. */
  stringValue?: string;
}

// Multi-character operators must be tried before their single-character
// prefixes (e.g. `<=` before `<`, `&&` before a lone `&`).
const MULTI_CHAR_OPS = ['||', '&&', '==', '!=', '<=', '>='];
const SINGLE_CHAR_OPS = ['<', '>', '+', '-', '*', '/', '%', '!', '?', ':'];
const PUNCT = ['(', ')', '[', ']', '.'];

const ID_START = /[_a-zA-Z]/;
// Matches the grammar's ID terminal: /[_a-zA-Z]\w*(-\w+)*/ — word chars with
// internal hyphen groups (a hyphen must be followed by at least one word char).
const ID_REGEX = /^[_a-zA-Z]\w*(?:-\w+)*/;
const DECIMAL_REGEX = /^[0-9]+\.[0-9]+/;
const INT_REGEX = /^[0-9]+/;

/**
 * Tokenize the inner expression text. Returns the token list, or `undefined`
 * when an illegal character or an unterminated string is encountered (which
 * routes the body to the raw fallback).
 */
function tokenize(input: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // Whitespace.
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '\f' ||
      ch === '\v'
    ) {
      i++;
      continue;
    }

    // String literal (single or double quoted), with backslash escapes — this
    // mirrors the grammar's STRING terminal /"(\\.|[^"\\])*"/ (and `'…'`).
    if (ch === '"' || ch === "'") {
      const lit = readString(input, i, ch);
      if (lit === undefined) {
        return undefined; // unterminated string → raw
      }
      tokens.push({ type: 'string', value: lit.raw, stringValue: lit.value });
      i = lit.end;
      continue;
    }

    // Numbers: DECIMAL before INT (longer match wins, as in the grammar lexer).
    const rest = input.slice(i);
    const dec = DECIMAL_REGEX.exec(rest);
    if (dec) {
      tokens.push({ type: 'decimal', value: dec[0] });
      i += dec[0].length;
      continue;
    }
    const int = INT_REGEX.exec(rest);
    if (int) {
      tokens.push({ type: 'int', value: int[0] });
      i += int[0].length;
      continue;
    }

    // Identifiers / keyword-literals.
    if (ID_START.test(ch)) {
      const idMatch = ID_REGEX.exec(rest);
      // ID_REGEX is anchored and ch is an id-start char, so this always matches.
      const word = idMatch![0];
      if (word === 'true' || word === 'false') {
        tokens.push({ type: 'bool', value: word });
      } else if (word === 'null') {
        tokens.push({ type: 'null', value: word });
      } else {
        tokens.push({ type: 'id', value: word });
      }
      i += word.length;
      continue;
    }

    // Multi-char operators.
    const two = input.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    // Single-char operators.
    if (SINGLE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Punctuation (accessors / parens).
    if (PUNCT.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }

    // Anything else (e.g. `@`, `:` outside of ternary handled above, `,`) is
    // outside the subset → raw.
    return undefined;
  }

  return tokens;
}

/**
 * Read a quoted string literal starting at `start` (the opening quote `quote`).
 * Returns the raw lexeme, the decoded value, and the index just past the
 * closing quote — or `undefined` when the string is unterminated.
 */
function readString(
  input: string,
  start: number,
  quote: string,
): { raw: string; value: string; end: number } | undefined {
  let i = start + 1;
  let value = '';
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      // Backslash escape: keep the next char literally (matches /\\./).
      if (i + 1 >= input.length) {
        return undefined;
      }
      value += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { raw: input.slice(start, i + 1), value, end: i + 1 };
    }
    value += ch;
    i++;
  }
  return undefined; // no closing quote
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

/**
 * A recursive-descent parser over the JUEL subset token stream. Precedence
 * climbs ternary → logical-or → logical-and → equality → relational → additive
 * → multiplicative → unary → primary, exactly matching the grammar. Binary
 * levels are left-associative.
 *
 * On any structural error a {@link ParseError} is thrown, which {@link parseJuel}
 * catches and converts to a raw result.
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  /** True when the whole token stream has been consumed. */
  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  /** Parse a full expression (entry point). */
  parseExpr(): JuelNode {
    return this.parseTernary();
  }

  // ── ternary ───────────────────────────────────────────────────────────────
  private parseTernary(): JuelNode {
    const condition = this.parseLogicalOr();
    if (this.matchOp('?')) {
      const whenTrue = this.parseLogicalOr();
      this.expectOp(':');
      const whenFalse = this.parseLogicalOr();
      return { kind: 'ternary', condition, whenTrue, whenFalse };
    }
    return condition;
  }

  // ── binary levels (left-associative) ───────────────────────────────────────
  private parseLogicalOr(): JuelNode {
    return this.parseBinaryLevel(['||'], () => this.parseLogicalAnd());
  }

  private parseLogicalAnd(): JuelNode {
    return this.parseBinaryLevel(['&&'], () => this.parseEquality());
  }

  private parseEquality(): JuelNode {
    return this.parseBinaryLevel(['==', '!='], () => this.parseRelational());
  }

  private parseRelational(): JuelNode {
    // Grammar order is `<= >= < >`; longer operators are already lexed as a
    // single token, so the set membership check below is order-independent.
    return this.parseBinaryLevel(['<=', '>=', '<', '>'], () =>
      this.parseAdditive(),
    );
  }

  private parseAdditive(): JuelNode {
    return this.parseBinaryLevel(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): JuelNode {
    return this.parseBinaryLevel(['*', '/', '%'], () => this.parseUnary());
  }

  /**
   * Parse a left-associative binary level: `operand (op operand)*` where `op`
   * is any of `ops`. Shared by all five precedence levels.
   */
  private parseBinaryLevel(ops: BinaryOp[], operand: () => JuelNode): JuelNode {
    let left = operand();
    for (;;) {
      const op = this.peekOp();
      if (op !== undefined && (ops as string[]).includes(op)) {
        this.pos++;
        const right = operand();
        left = { kind: 'binary', op: op as BinaryOp, left, right };
      } else {
        return left;
      }
    }
  }

  // ── unary ──────────────────────────────────────────────────────────────────
  private parseUnary(): JuelNode {
    const op = this.peekOp();
    if (op === '!' || op === '-') {
      this.pos++;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePrimary();
  }

  // ── primary ─────────────────────────────────────────────────────────────────
  private parsePrimary(): JuelNode {
    const tok = this.peek();
    if (tok === undefined) {
      throw new ParseError('unexpected end of input');
    }

    switch (tok.type) {
      case 'int':
        this.pos++;
        return { kind: 'int', value: Number(tok.value) };
      case 'decimal':
        this.pos++;
        return { kind: 'decimal', value: Number(tok.value) };
      case 'string':
        this.pos++;
        return { kind: 'string', value: tok.stringValue ?? '' };
      case 'bool':
        this.pos++;
        return { kind: 'bool', value: tok.value as 'true' | 'false' };
      case 'null':
        this.pos++;
        return { kind: 'null' };
      case 'id':
        return this.parseVarRef();
      case 'punct':
        if (tok.value === '(') {
          this.pos++;
          const inner = this.parseExpr();
          this.expectPunct(')');
          return { kind: 'paren', inner };
        }
        throw new ParseError(`unexpected punctuation '${tok.value}'`);
      default:
        throw new ParseError(`unexpected token '${tok.value}'`);
    }
  }

  /** Parse `id (.prop | [expr])*`. */
  private parseVarRef(): JuelNode {
    const idTok = this.advance();
    const accessors: Accessor[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok?.type === 'punct' && tok.value === '.') {
        this.pos++;
        const prop = this.peek();
        if (prop?.type !== 'id') {
          throw new ParseError('expected property name after "."');
        }
        this.pos++;
        accessors.push({ prop: prop.value });
        continue;
      }
      if (tok?.type === 'punct' && tok.value === '[') {
        this.pos++;
        const index = this.parseExpr();
        this.expectPunct(']');
        accessors.push({ index });
        continue;
      }
      break;
    }
    return { kind: 'varRef', name: idTok.value, accessors };
  }

  // ── token helpers ───────────────────────────────────────────────────────────
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) {
      throw new ParseError('unexpected end of input');
    }
    this.pos++;
    return tok;
  }

  /** Return the current operator lexeme, or undefined if not an operator. */
  private peekOp(): string | undefined {
    const tok = this.tokens[this.pos];
    return tok?.type === 'op' ? tok.value : undefined;
  }

  /** Consume the current token iff it is the operator `op`. */
  private matchOp(op: string): boolean {
    if (this.peekOp() === op) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectOp(op: string): void {
    if (!this.matchOp(op)) {
      throw new ParseError(`expected operator '${op}'`);
    }
  }

  private expectPunct(p: string): void {
    const tok = this.tokens[this.pos];
    if (tok?.type === 'punct' && tok.value === p) {
      this.pos++;
      return;
    }
    throw new ParseError(`expected '${p}'`);
  }
}

/** Internal control-flow signal for an out-of-subset / malformed parse. */
class ParseError extends Error {}

// ---------------------------------------------------------------------------
// Surface renderer (mirrors `renderExpressionInner` in @bpmn-script/language)
// ---------------------------------------------------------------------------

/**
 * Render a {@link JuelNode} to its bare DSL surface text (no `${…}` wrapper).
 * The output matches the grammar's `renderExpressionInner` canonical form so
 * that `parseJuel(renderExpression(x))` is idempotent on the subset.
 */
function renderNode(node: JuelNode): string {
  switch (node.kind) {
    case 'int':
    case 'decimal':
      return String(node.value);
    case 'string':
      // Canonical form uses double quotes (re-escaping any embedded quote).
      return `"${node.value.replace(/"/g, '\\"')}"`;
    case 'bool':
      return node.value;
    case 'null':
      return 'null';
    case 'varRef':
      return node.name + node.accessors.map(renderAccessor).join('');
    case 'unary':
      return `${node.op}${renderNode(node.operand)}`;
    case 'binary':
      return `${renderNode(node.left)} ${node.op} ${renderNode(node.right)}`;
    case 'ternary':
      return (
        `${renderNode(node.condition)} ? ` +
        `${renderNode(node.whenTrue)} : ` +
        `${renderNode(node.whenFalse)}`
      );
    case 'paren':
      return `(${renderNode(node.inner)})`;
  }
}

/** Render a single accessor (`.prop` or `[index]`). */
function renderAccessor(accessor: Accessor): string {
  if ('prop' in accessor) {
    return `.${accessor.prop}`;
  }
  return `[${renderNode(accessor.index)}]`;
}
