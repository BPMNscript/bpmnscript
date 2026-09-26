/**
 * JUEL subset parser for the import path: a `${...}`/`#{...}` body inside the
 * subset prints as bare DSL, anything else (method calls, `fn:` functions,
 * malformed text) as the quoted raw form with its original opener.
 *
 * Precedence mirrors the Langium expression grammar (a test cross-checks it):
 * ternary, `|| &&`, `== !=`, `<= >= < >`, `+ -`, `* / %`, unary `! -`, primary.
 * Hand-rolled so `xmlToIr` and `irToDsl` stay synchronous. Output matches
 * `renderExpression` in `@bpmn-script/language`, so a printed body re-parses
 * to itself.
 */

import { ID_TERMINAL } from '@bpmn-script/language';

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

/** Raw `text` is the body without its wrapper; `open` is the wrapper's first char (`$` if none). */
export type ExprResult =
  | { kind: 'structured'; expr: JuelNode }
  | { kind: 'raw'; text: string; open: '$' | '#' };

export function parseJuel(body: string): ExprResult {
  const open = /^#\{/.test(body.trim()) ? '#' : '$';
  const inner = stripWrapper(body);
  if (inner === undefined) {
    return { kind: 'raw', text: stripWrapperLenient(body), open };
  }
  try {
    const tokens = tokenize(inner);
    if (tokens === undefined) {
      return { kind: 'raw', text: inner, open };
    }
    const parser = new Parser(tokens);
    const expr = parser.parseExpr();
    // Trailing tokens (a method call's `()`) put the body outside the subset.
    if (!parser.atEnd()) {
      return { kind: 'raw', text: inner, open };
    }
    return { kind: 'structured', expr };
  } catch {
    return { kind: 'raw', text: inner, open };
  }
}

export function renderRawFallback(result: ExprResult): string {
  if (result.kind === 'raw') {
    return `"${result.open}{${escapeQuoted(result.text)}}"`;
  }
  return renderNode(result.expr);
}

/** Inverse of the grammar's `convertString`: these five are the only escapes it resolves. */
export function escapeQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Operaton evaluates `#{...}` and `${...}` alike, so a structured `#{...}`
 * body prints bare and is rewritten inside `${...}`.
 */
const OPEN_WRAPPER = /^[$#]\{/;

function stripWrapper(body: string): string | undefined {
  const trimmed = body.trim();
  if (
    OPEN_WRAPPER.test(trimmed) &&
    trimmed.endsWith('}') &&
    trimmed.length >= 3
  ) {
    return trimmed.slice(2, -1);
  }
  return undefined;
}

/**
 * Drops only the opening delimiter: taking a closing brace it never opened
 * would corrupt the text {@link renderRawFallback} re-wraps.
 */
function stripWrapperLenient(body: string): string {
  const trimmed = body.trim();
  return OPEN_WRAPPER.test(trimmed) ? trimmed.slice(2) : trimmed;
}

type TokenType =
  'int' | 'decimal' | 'string' | 'id' | 'bool' | 'null' | 'op' | 'punct';

interface Token {
  type: TokenType;
  value: string;
  stringValue?: string;
}

const MULTI_CHAR_OPS = ['||', '&&', '==', '!=', '<=', '>='];
const SINGLE_CHAR_OPS = ['<', '>', '+', '-', '*', '/', '%', '!', '?', ':'];
const PUNCT = ['(', ')', '[', ']', '.'];

const ID_REGEX = new RegExp(`^${ID_TERMINAL.source}`, ID_TERMINAL.flags);
const DECIMAL_REGEX = /^[0-9]+\.[0-9]+/;
const INT_REGEX = /^[0-9]+/;

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

    if (ch === '"' || ch === "'") {
      const lit = readString(input, i, ch);
      if (lit === undefined) {
        return undefined;
      }
      tokens.push({ type: 'string', value: lit.raw, stringValue: lit.value });
      i = lit.end;
      continue;
    }

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

    const idMatch = ID_REGEX.exec(rest);
    if (idMatch) {
      const word = idMatch[0];
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

    return undefined;
  }

  return tokens;
}

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

/** Binary levels are left-associative; {@link ParseError} becomes a raw result. */
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
        this.pos++;
        return this.parseVarRef(tok.value);
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

  private parseVarRef(name: string): JuelNode {
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
    return { kind: 'varRef', name, accessors };
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
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

class ParseError extends Error {}

function renderNode(node: JuelNode): string {
  switch (node.kind) {
    case 'int':
    case 'decimal':
      return String(node.value);
    case 'string':
      // Langium's `convertEscapeCharacter` drops the backslash before unknown
      // characters, so only `\\` reads back as a backslash; operaton-juel's
      // scanner accepts it too.
      return `"${escapeQuoted(node.value)}"`;
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
