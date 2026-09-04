/**
 * Parser, classifier, and DSL serializer for the JUEL subset, on the import
 * path. It decides whether a raw `${...}` body fits the subset and can print as
 * clean unquoted DSL, or has to fall back to the quoted `"${...}"` raw form.
 *
 * The subset boundary is the Langium expression sub-grammar in
 * `packages/language/src/bpmn-script.langium`, whose precedence the
 * recursive-descent parser below reproduces. A test cross-checks this ladder
 * against the real grammar, so the two cannot drift:
 *
 *   ternary          c ? t : f
 *   logical          ||  &&
 *   equality         ==  !=
 *   relational       <=  >=  <  >
 *   additive         +  -
 *   multiplicative   *  /  %
 *   unary            !x  -x
 *   primary          int | decimal | string | bool | null
 *                    | varRef (id with `.prop` / `[expr]` accessors)
 *                    | ( expr )
 *
 * A method or bean call (`x.foo()`), a JUEL function (`fn:size(x)`), or a
 * malformed body is classified raw.
 *
 * Hand-rolled rather than re-invoking Langium: a synchronous, dependency-free
 * parser keeps `xmlToIr` and `irToDsl` off the language package's async parse
 * machinery on the hot import path.
 *
 * The surface form is shared with `renderExpression` in `@bpmn-script/language`:
 * double-quoted strings, spaced operators, `.prop`/`[idx]` accessors, author
 * parentheses preserved. That makes `parseJuel(renderExpression(x))` idempotent
 * on the subset.
 */

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

export type Accessor = { prop: string } | { index: JuelNode };

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

/** A raw `text` is the verbatim inner body, without the `${...}` wrapper. */
export type ExprResult =
  { kind: 'structured'; expr: JuelNode } | { kind: 'raw'; text: string };

/** Never throws: anything outside the subset comes back as a raw result. */
export function parseJuel(body: string): ExprResult {
  const inner = stripWrapper(body);
  if (inner === undefined) {
    return { kind: 'raw', text: stripWrapperLenient(body) };
  }
  try {
    const tokens = tokenize(inner);
    if (tokens === undefined) {
      return { kind: 'raw', text: inner };
    }
    const parser = new Parser(tokens);
    const expr = parser.parseExpr();
    // Trailing tokens, such as the `()` of a method call, put the body outside
    // the subset, so the parse has to consume the whole stream.
    if (!parser.atEnd()) {
      return { kind: 'raw', text: inner };
    }
    return { kind: 'structured', expr };
  } catch {
    return { kind: 'raw', text: inner };
  }
}

/**
 * The DSL surface string `irToDsl` writes into a condition or attribute:
 * `amount > 1000` when structured, the quoted `"${...}"` fallback when raw, so
 * an out-of-subset body survives the round trip verbatim.
 */
export function renderRawFallback(result: ExprResult): string {
  if (result.kind === 'raw') {
    return `"\${${result.text}}"`;
  }
  return renderNode(result.expr);
}

/** `undefined` when the body is not `${...}`-shaped, routing it to the fallback. */
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

/** Only fills the `text` of a raw result. Never affects classification. */
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

type TokenType =
  'int' | 'decimal' | 'string' | 'id' | 'bool' | 'null' | 'op' | 'punct';

interface Token {
  type: TokenType;
  /** Raw text for `op` and `punct`, the decoded value otherwise. */
  value: string;
  /** String tokens only: the unescaped content. */
  stringValue?: string;
}

// Tried before their single-character prefixes: `<=` before `<`.
const MULTI_CHAR_OPS = ['||', '&&', '==', '!=', '<=', '>='];
const SINGLE_CHAR_OPS = ['<', '>', '+', '-', '*', '/', '%', '!', '?', ':'];
const PUNCT = ['(', ')', '[', ']', '.'];

const ID_START = /[_a-zA-Z]/;
// The grammar's ID terminal: word chars with internal hyphen groups, where a
// hyphen must be followed by at least one word char.
const ID_REGEX = /^[_a-zA-Z]\w*(?:-\w+)*/;
const DECIMAL_REGEX = /^[0-9]+\.[0-9]+/;
const INT_REGEX = /^[0-9]+/;

/** `undefined` on an illegal character or an unterminated string. */
function tokenize(input: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

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

    // Mirrors the grammar's STRING terminal, single or double quoted.
    if (ch === '"' || ch === "'") {
      const lit = readString(input, i, ch);
      if (lit === undefined) {
        return undefined;
      }
      tokens.push({ type: 'string', value: lit.raw, stringValue: lit.value });
      i = lit.end;
      continue;
    }

    // DECIMAL before INT: longer match wins, as in the grammar lexer.
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

    const two = input.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    if (SINGLE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    if (PUNCT.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }

    // `@`, `,` and anything else are outside the subset.
    return undefined;
  }

  return tokens;
}

/** `end` is the index just past the closing quote. `undefined` if unterminated. */
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
      // Backslash escape: the next char is kept literally.
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
  return undefined;
}

/**
 * Climbs the precedence ladder in the module header. Binary levels are
 * left-associative. A structural error throws {@link ParseError}, which
 * {@link parseJuel} turns into a raw result.
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  parseExpr(): JuelNode {
    return this.parseTernary();
  }

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

  /** `operand (op operand)*`, shared by every binary level. */
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

  private parseUnary(): JuelNode {
    const op = this.peekOp();
    if (op === '!' || op === '-') {
      this.pos++;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePrimary();
  }

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

  /** `id (.prop | [expr])*`. */
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

  private peekOp(): string | undefined {
    const tok = this.tokens[this.pos];
    return tok?.type === 'op' ? tok.value : undefined;
  }

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

/** Control-flow signal for an out-of-subset or malformed parse. */
class ParseError extends Error {}

/**
 * Bare DSL surface text, no `${...}` wrapper. Matches the canonical form of
 * `renderExpressionInner` in `@bpmn-script/language`, which is what makes
 * `parseJuel(renderExpression(x))` idempotent on the subset.
 */
function renderNode(node: JuelNode): string {
  switch (node.kind) {
    case 'int':
    case 'decimal':
      return String(node.value);
    case 'string':
      // Canonical form is double-quoted, so an embedded quote is re-escaped.
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

function renderAccessor(accessor: Accessor): string {
  if ('prop' in accessor) {
    return `.${accessor.prop}`;
  }
  return `[${renderNode(accessor.index)}]`;
}
