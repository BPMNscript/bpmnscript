/**
 * Unit tests for the standalone JUEL-subset expression parser / serializer
 * (`src/juel.ts`).
 *
 * This module is the import-side mirror of the language package's
 * expression sub-grammar. On import, `xmlToIr` reads raw `${…}`
 * bodies out of BPMN XML and hands them to `parseJuel`; `irToDsl`
 * then renders the result back to DSL surface syntax. The contract:
 *
 *   - A body inside the JUEL subset → a structured result, rendered as a
 *     bare unquoted expression (`amount > 1000`).
 *   - A body outside the subset (method/bean calls, JUEL functions, or anything
 *     unparseable) → a `{ kind: 'raw' }` result, rendered as the quoted
 *     `"${…}"` fallback. `parseJuel` never throws.
 *
 * The subset boundary is fixed by the grammar; the final two suites
 * (`idempotence with the grammar renderer` and `subset parity with the real
 * grammar`) cross-check that this hand-rolled parser accepts/rejects exactly
 * what the Langium grammar does, so a divergence cannot silently break
 * round-trip.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import {
  createBpmnScriptServices,
  renderExpression,
} from '@bpmn-script/language';
import type { Expr, Model } from '@bpmn-script/language';

import { parseJuel, renderRawFallback } from '../src/juel.js';

// ---------------------------------------------------------------------------
// Structured-vs-raw classification
// ---------------------------------------------------------------------------

describe('parseJuel — structured classification', () => {
  it('classifies a relational comparison as structured', () => {
    const r = parseJuel('${amount > 1000}');
    expect(r.kind).toBe('structured');
  });

  it('renders a structured comparison as a bare unquoted expression', () => {
    const r = parseJuel('${amount > 1000}');
    expect(renderRawFallback(r)).toBe('amount > 1000');
  });

  it('classifies dotted property access as structured', () => {
    expect(parseJuel('${order.total}').kind).toBe('structured');
    expect(renderRawFallback(parseJuel('${order.total}'))).toBe('order.total');
  });

  it('classifies numeric index access as structured', () => {
    expect(parseJuel('${items[0]}').kind).toBe('structured');
    expect(renderRawFallback(parseJuel('${items[0]}'))).toBe('items[0]');
  });

  it('classifies string-key index access as structured', () => {
    expect(parseJuel("${map['k']}").kind).toBe('structured');
    // String literals canonicalize to double quotes (matches renderExpression).
    expect(renderRawFallback(parseJuel("${map['k']}"))).toBe('map["k"]');
  });

  it.each([
    '${true}',
    '${false}',
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
    '${a >= b}',
    '${total % 2}',
    '${ready ? a : b}',
    '${order.items[0].price}',
    '${flag-name}',
  ])('classifies %s as structured', (body) => {
    expect(parseJuel(body).kind).toBe('structured');
  });
});

describe('parseJuel — raw fallback classification', () => {
  it('classifies a bean method call as raw', () => {
    const r = parseJuel('${myBean.check()}');
    expect(r.kind).toBe('raw');
  });

  it('renders a raw result as the quoted "${…}" fallback', () => {
    const r = parseJuel('${myBean.check()}');
    expect(renderRawFallback(r)).toBe('"${myBean.check()}"');
  });

  it('classifies a JUEL function call as raw', () => {
    expect(parseJuel('${fn:size(list)}').kind).toBe('raw');
  });

  it.each([
    '${execution.getVariable("x")}',
    '${obj.method().chained()}',
    '${a.b.c()}',
    '${size(list)}',
    '${ns:fn(x, y)}',
  ])('classifies %s as raw', (body) => {
    expect(parseJuel(body).kind).toBe('raw');
  });

  it('preserves the verbatim inner body on a raw result', () => {
    const r = parseJuel('${myBean.check()}');
    expect(r.kind).toBe('raw');
    if (r.kind === 'raw') {
      expect(r.text).toBe('myBean.check()');
    }
  });
});

// ---------------------------------------------------------------------------
// Totality — parseJuel must never throw, malformed input always yields raw
// ---------------------------------------------------------------------------

describe('parseJuel — totality (never throws)', () => {
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
  ];

  it.each(malformed)('never throws on %j', (body) => {
    expect(() => parseJuel(body)).not.toThrow();
  });

  it.each(malformed)('yields a raw result on %j', (body) => {
    expect(parseJuel(body).kind).toBe('raw');
  });

  it('renderRawFallback never throws on malformed input', () => {
    for (const body of malformed) {
      const r = parseJuel(body);
      expect(() => renderRawFallback(r)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-check infrastructure: parse a body through the REAL Langium grammar by
// wrapping it in `if (<body>) { }`. Returns the condition Expr if it parses to
// a NON-raw subset node, undefined if it does not parse or parses to a RawExpr.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * Classify a `${…}` body via the real grammar: returns 'structured' if the
 * inner body parses cleanly to a non-RawExpr condition node, else 'raw'.
 */
async function grammarClassify(body: string): Promise<'structured' | 'raw'> {
  // Strip the ${…} wrapper to get the inner expression, then embed it as an
  // `if` condition — the only statement position where a bare Expr appears.
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

// ---------------------------------------------------------------------------
// Idempotence with the grammar renderer: a structured AST → renderExpression →
// parseJuel must round-trip back to the same surface form (shared canonical
// notion). We drive the structured AST from the real grammar so the inputs are
// guaranteed to be in-subset.
// ---------------------------------------------------------------------------

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
    // String literals: verifies the grammar renderer (expression-render.ts) and
    // the transform renderer (juel.ts) agree on the canonical quoted form,
    // including re-escaping an embedded double quote.
    // `greeting` avoids the `label` keyword.
    'x == "hello"',
    'greeting == "say \\"hi\\""',
  ];

  it.each(structuredInputs)(
    'renderExpression(parse(%s)) re-parses to the same canonical surface',
    async (inner) => {
      const doc = await parse(`process P { if (${inner}) { } }`);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
      const stmt = doc.parseResult.value.processes[0].body[0];
      expect(stmt.$type).toBe('IfStatement');
      const cond = (stmt as { condition: Expr }).condition;

      // Grammar's canonical ${…} body for this AST.
      const canonical = renderExpression(cond);

      // parseJuel must accept the grammar's canonical body as structured and
      // render the same bare surface form that renderExpression's inner emits.
      const result = parseJuel(canonical);
      expect(result.kind).toBe('structured');

      // Idempotent: parsing the parser's own surface output yields the same
      // surface output again.
      const surface = renderRawFallback(result);
      const reparsed = parseJuel(`\${${surface}}`);
      expect(reparsed.kind).toBe('structured');
      expect(renderRawFallback(reparsed)).toBe(surface);

      // And the parser's surface matches the grammar renderer's canonical body
      // (both share the same canonical-form notion).
      expect(`\${${surface}}`).toBe(canonical);
    },
  );
});

// ---------------------------------------------------------------------------
// Subset-parity cross-check: parseJuel and the real grammar must classify the
// same representative input list identically (structured vs raw).
// ---------------------------------------------------------------------------

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
