import { describe, expect, it } from 'vitest';
import {
  isEquality,
  isLiteralString,
  renderExpression,
} from '@bpmn-script/language';
import type { Expr } from '@bpmn-script/language';

import { parseJuel, renderRawFallback } from '../src/juel.js';
import { parse } from './helpers/parse.js';

// The grammar's reading of `inner` as an `if` condition, or undefined when it does not parse.
async function grammarCondition(inner: string): Promise<Expr | undefined> {
  const doc = await parse(`process P { if (${inner}) { } }`);
  if (
    doc.parseResult.lexerErrors.length + doc.parseResult.parserErrors.length >
    0
  )
    return undefined;
  const stmt = doc.parseResult.value.processes[0]?.body[0];
  return stmt?.$type === 'IfStatement' ? (stmt.condition as Expr) : undefined;
}

describe('parseJuel: structured classification', () => {
  it.each([
    ['${amount > 1000}', 'amount > 1000'],
    ['#{lineCount}', 'lineCount'],
    ['${order.total}', 'order.total'],
    ['${items[0]}', 'items[0]'],
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
    ['${greeting == "say \\"hi\\""}', 'greeting == "say \\"hi\\""'],
  ])(
    'classifies %s as structured, rendered bare as %s, as the grammar reads and renders it',
    async (body, surface) => {
      const r = parseJuel(body);
      expect(r.kind).toBe('structured');
      expect(renderRawFallback(r)).toBe(surface);
      const cond = await grammarCondition(surface);
      expect(cond?.$type).not.toBe('RawExpr');
      expect(cond && renderExpression(cond)).toBe(`\${${surface}}`);
    },
  );
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
  ])('%s', async (body, text, open) => {
    expect(parseJuel(body)).toEqual({ kind: 'raw', text, open });
    if (open === '$' && body.startsWith('${')) {
      expect((await grammarCondition(text))?.$type ?? 'RawExpr').toBe(
        'RawExpr',
      );
    }
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

  it.each(malformed)(
    'yields a raw result on %j, as the grammar does',
    async (body) => {
      expect(parseJuel(body).kind).toBe('raw');
      if (/^\$\{.*\}$/.test(body)) {
        expect(
          (await grammarCondition(body.slice(2, -1)))?.$type ?? 'RawExpr',
        ).toBe('RawExpr');
      }
    },
  );
});
