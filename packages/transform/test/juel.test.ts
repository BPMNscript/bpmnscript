/**
 * The JUEL-subset parser and serializer in `src/juel.ts`: a body inside the
 * subset is structured and prints bare, anything else is raw and prints as
 * the quoted template with the opener it came with, and `parseJuel` never
 * throws. The last two suites cross-check the hand-rolled parser against the
 * real Langium grammar, so the two cannot drift apart.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import {
  createBpmnScriptServices,
  isEquality,
  isLiteralString,
  renderExpression,
} from '@bpmn-script/language';
import type { Expr, Model } from '@bpmn-script/language';

import { parseJuel, renderRawFallback } from '../src/juel.js';

describe('parseJuel: structured classification', () => {
  it.each([
    ['${amount > 1000}', 'amount > 1000'],
    // Operaton accepts either delimiter; a structured body prints bare either way.
    ['#{lineCount}', 'lineCount'],
    ['${order.total}', 'order.total'],
    ['${items[0]}', 'items[0]'],
    // String literals canonicalize to double quotes (matches renderExpression).
    ["${map['k']}", 'map["k"]'],
    ['${true}', 'true'],
    ['${false}', 'false'],
    ['${null}', 'null'],
    ['${42}', '42'],
    ['${3.14}', '3.14'],
    ['${"hello"}', '"hello"'],
    ['${!done}', '!done'],
    ['${-balance}', '-balance'],
    ['${a + b * c}', 'a + b * c'],
    ['${(a + b) * c}', '(a + b) * c'],
    ['${a && b || c}', 'a && b || c'],
    ['${x == 5}', 'x == 5'],
    ['${x != 5}', 'x != 5'],
    ['${a <= b}', 'a <= b'],
    ['${a >= b}', 'a >= b'],
    ['${total % 2}', 'total % 2'],
    ['${ready ? a : b}', 'ready ? a : b'],
    ['${order.items[0].price}', 'order.items[0].price'],
    ['${flag-name}', 'flag-name'],
    ['${region == "a\\\\b"}', 'region == "a\\\\b"'],
    ['${map["a\\\\b"]}', 'map["a\\\\b"]'],
  ])('classifies %s as structured, rendered bare as %s', (body, surface) => {
    const r = parseJuel(body);
    expect(r.kind).toBe('structured');
    expect(renderRawFallback(r)).toBe(surface);
  });
});

describe('parseJuel: raw classification keeps the verbatim body and its opener', () => {
  it.each([
    ['${execution.getVariable("x")}', 'execution.getVariable("x")', '$'],
    ['${obj.method().chained()}', 'obj.method().chained()', '$'],
    ['${a.b.c()}', 'a.b.c()', '$'],
    ['${size(list)}', 'size(list)', '$'],
    ['${fn:size(list)}', 'fn:size(list)', '$'],
    ['${ns:fn(x, y)}', 'ns:fn(x, y)', '$'],
    ['#{myBean.check()}', 'myBean.check()', '#'],
    // A wrapperless body is tagged $ even when its text starts with #.
    ['#foo', '#foo', '$'],
  ])('%s', (body, text, open) => {
    expect(parseJuel(body)).toEqual({ kind: 'raw', text, open });
  });
});

describe('renderRawFallback: a raw body prints as a quoted template the grammar reads back to the same text', () => {
  it.each([
    [
      'an out-of-subset ${...} body',
      '${myBean.check()}',
      '"${myBean.check()}"',
    ],
    [
      'an out-of-subset #{...} body keeps its opener',
      '#{myBean.check()}',
      '"#{myBean.check()}"',
    ],
    [
      'a quote inside the body is escaped once',
      '${execution.getVariable("x")}',
      '"${execution.getVariable(\\"x\\")}"',
    ],
    [
      'a composite body keeps the opener it starts with',
      '${a} #{b}',
      '"${a} #{b}"',
    ],
  ])('%s: %s prints as %s', async (_title, body, printed) => {
    expect(renderRawFallback(parseJuel(body))).toBe(printed);
    const doc = await parse(`process P { if (${printed}) { } }`);
    expect(doc.parseResult.parserErrors).toEqual([]);
    const stmt = doc.parseResult.value.processes[0].body[0];
    const cond = (stmt as { condition: Expr }).condition;
    expect(cond.$type === 'RawExpr' && cond.raw).toBe(body);
  });
});

describe('a string literal prints with the escapes the grammar reads back to the same characters', () => {
  it.each([
    ['a backslash', '${region == "a\\\\b"}', 'a\\b'],
    ['an embedded quote', '${region == "say \\"hi\\""}', 'say "hi"'],
  ])('%s', async (_title, body, chars) => {
    const surface = renderRawFallback(parseJuel(body));
    const doc = await parse(`process P { if (${surface}) { } }`);
    expect(doc.parseResult.parserErrors).toEqual([]);
    const stmt = doc.parseResult.value.processes[0].body[0];
    const cond = (stmt as { condition: Expr }).condition;
    expect(
      isEquality(cond) && isLiteralString(cond.right) && cond.right.value,
    ).toBe(chars);
  });
});

describe('parseJuel: a malformed body is raw rather than a throw', () => {
  const malformed = [
    '${',
    '${}',
    '${)}',
    '${(}',
    '${a +}',
    '${+ a}',
    '${a b}',
    '${a ? b}',
    '${a ? b :}',
    '${&&}',
    '${[0]}',
    '${.foo}',
    '${a.}',
    '${"unterminated}',
    '${1.2.3}',
    '${@bad}',
    '',
    '   ',
    'no-wrapper-at-all',
    '${a == }',
    '${* 5}',
    '${"a\\',
    '${(a}',
    '${a[0}',
  ];

  it.each(malformed)('yields a raw result on %j', (body) => {
    expect(parseJuel(body).kind).toBe('raw');
  });
});

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * The real grammar's verdict on a `${...}` body, read off an `if` condition,
 * the one statement position where a bare expression appears.
 */
async function grammarClassify(body: string): Promise<'structured' | 'raw'> {
  const inner = body.replace(/^\$\{/, '').replace(/\}$/, '');
  const doc = await parse(`process P { if (${inner}) { } }`);
  if (doc.parseResult.parserErrors.length > 0) {
    return 'raw';
  }
  const proc = doc.parseResult.value.processes[0];
  const stmt = proc?.body[0];
  if (!stmt || stmt.$type !== 'IfStatement') {
    return 'raw';
  }
  const cond = stmt.condition as Expr;
  return cond.$type === 'RawExpr' ? 'raw' : 'structured';
}

describe('idempotence with the grammar renderExpression', () => {
  const structuredInputs = [
    'amount > 1000',
    'order.total',
    'items[0]',
    'a + b * c',
    '(a + b) * c',
    'a && b || c',
    'x == 5',
    'ready ? a : b',
    '!done',
    '-balance',
    'order.items[0].price',
    // Both renderers must agree on the quoted form, an embedded quote and
    // backslash included. `greeting` avoids the `label` keyword.
    'x == "hello"',
    'greeting == "say \\"hi\\""',
    'x == "a\\\\b"',
  ];

  it.each(structuredInputs)(
    'renderExpression(parse(%s)) re-parses to the same canonical surface',
    async (inner) => {
      const doc = await parse(`process P { if (${inner}) { } }`);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
      const stmt = doc.parseResult.value.processes[0].body[0];
      expect(stmt.$type).toBe('IfStatement');
      const cond = (stmt as { condition: Expr }).condition;

      const canonical = renderExpression(cond);
      const result = parseJuel(canonical);
      expect(result.kind).toBe('structured');

      const surface = renderRawFallback(result);
      const reparsed = parseJuel(`\${${surface}}`);
      expect(reparsed.kind).toBe('structured');
      expect(renderRawFallback(reparsed)).toBe(surface);
      expect(`\${${surface}}`).toBe(canonical);
    },
  );
});

describe('subset parity with the real grammar', () => {
  const cases = [
    // structured
    '${amount > 1000}',
    '${order.total}',
    '${items[0]}',
    "${map['k']}",
    '${true}',
    '${null}',
    '${42}',
    '${3.14}',
    '${"hello"}',
    '${!done}',
    '${-balance}',
    '${a + b * c}',
    '${(a + b) * c}',
    '${a && b || c}',
    '${x == 5}',
    '${x != 5}',
    '${a <= b}',
    '${ready ? a : b}',
    '${order.items[0].price}',
    '${flag-name}',
    // raw
    '${myBean.check()}',
    '${fn:size(list)}',
    '${execution.getVariable("x")}',
    '${size(list)}',
    '${a +}',
    '${)}',
    '${a b}',
  ];

  it.each(cases)('classifies %s the same as the grammar', async (body) => {
    const grammarKind = await grammarClassify(body);
    const parserKind = parseJuel(body).kind;
    expect(parserKind).toBe(grammarKind);
  });
});
