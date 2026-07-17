/**
 * Cross-stage round-trip smoke for the executable task bindings and inline
 * script task: service `expression`, service `delegate`, `external`, and
 * `script`.
 *
 * Each single-stage transform (desugar, generate, decompile, print) already
 * has its own focused tests. What none of them catches on its own is a
 * field-name or binding-kind mismatch BETWEEN stages — e.g. the generator
 * writing an attribute the importer reads under a different name. This file
 * drives one minimal example program per construct through the full pipeline
 *
 *   DSL → astToIr → irToXml → xmlToIr → irToDsl → (re-parse)
 *
 * and asserts the construct survives every hop. The example programs are inline
 * so the test is self-contained. It intentionally stops short of idempotence
 * ceremony (no repeated round-trips, no IR normalization) and does not touch
 * Docker or a live Operaton engine — see `tests/round-trip.test.ts` /
 * `tests/round-trip-constructs.test.ts` for the structured-control-flow
 * round-trip and `tests/e2e/*` for the engine tests.
 *
 * The `delegate` case additionally asserts the alias both directions in one
 * flow: the DSL `delegate = "${…}"` must generate `operaton:delegateExpression`
 * in the XML (not a `delegateExpression` keyword ever appearing in DSL), and
 * the re-emitted DSL after import must be `delegate` again (not
 * `delegateExpression`) — the alias is a printer-side convenience, not a
 * second surface keyword.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

// ---------------------------------------------------------------------------
// Inline example programs — one minimal process per construct. Kept as string
// constants (not files) so this smoke test carries its own inputs.
// ---------------------------------------------------------------------------

const SERVICE_EXPRESSION_SRC =
  'process shipping-quote {\n' +
  '  start OrderPlaced\n' +
  '  service QuoteShipping { expression = "${shippingBean.quote(order)}" }\n' +
  '  end Done\n' +
  '}\n';

const SERVICE_DELEGATE_SRC =
  'process payment-charge {\n' +
  '  start OrderPlaced\n' +
  '  service ChargeCustomer { delegate = "${chargeService}" }\n' +
  '  end Done\n' +
  '}\n';

const EXTERNAL_TASK_SRC =
  'process shipment-label {\n' +
  '  start OrderPlaced\n' +
  '  external PrintLabel { topic = "print-label" }\n' +
  '  end Done\n' +
  '}\n';

const SCRIPT_TASK_SRC =
  'process order-discount {\n' +
  '  start OrderPlaced\n' +
  '  script ComputeDiscount ```js\n' +
  'var discount = amount * 0.1;\n' +
  'execution.setVariable("discount", discount);\n' +
  '```\n' +
  '  end Done\n' +
  '}\n';

// ---------------------------------------------------------------------------
// Langium parse helper — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the
 * source has any parser error — a round-tripped source that does not re-parse
 * is itself a round-trip failure, so it must abort the test, never be
 * swallowed.
 */
async function parseToAst(source: string) {
  const document = await parse(source);
  const errors = document.parseResult.parserErrors;
  if (errors.length > 0) {
    throw new Error(
      'Parser errors in round-tripped DSL:\n' +
        errors.map((e) => e.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

function findServiceTask(ir: BpmnProcess) {
  const el = ir.flowElements.find((fe) => fe.kind === 'serviceTask');
  if (el === undefined || el.kind !== 'serviceTask') {
    throw new Error('expected a serviceTask flow element');
  }
  return el;
}

function findScriptTask(ir: BpmnProcess) {
  const el = ir.flowElements.find((fe) => fe.kind === 'scriptTask');
  if (el === undefined || el.kind !== 'scriptTask') {
    throw new Error('expected a scriptTask flow element');
  }
  return el;
}

// ===========================================================================
// service `expression` binding.
// ===========================================================================

describe('round-trip: service task with an `expression` binding', () => {
  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(SERVICE_EXPRESSION_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars to an `expression` binding carrying the raw ${…} text', () => {
    const binding = findServiceTask(irInitial).binding;
    expect(binding).toEqual({
      kind: 'expression',
      expression: '${shippingBean.quote(order)}',
    });
  });

  it('generates `operaton:expression` in the BPMN XML', () => {
    expect(xml).toContain('operaton:expression="${shippingBean.quote(order)}"');
  });

  it('re-imports to the same `expression` binding', () => {
    expect(findServiceTask(irImported).binding).toEqual({
      kind: 'expression',
      expression: '${shippingBean.quote(order)}',
    });
  });

  it('re-emits `expression = "${…}"` and re-parses with zero errors', async () => {
    expect(reemittedDsl).toContain(
      'expression = "${shippingBean.quote(order)}"',
    );
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ===========================================================================
// service `delegate` binding — the delegateExpression alias, both directions
// in one flow.
// ===========================================================================

describe('round-trip: service task with a `delegate` binding (delegateExpression alias)', () => {
  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(SERVICE_DELEGATE_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars `delegate = "${…}"` to a `delegateExpression` binding', () => {
    expect(findServiceTask(irInitial).binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
  });

  it('both directions: DSL `delegate` generates XML `operaton:delegateExpression`, and the re-emitted DSL is `delegate` again', () => {
    // Direction 1 — DSL → XML: the generated attribute is the real Operaton
    // name, never the DSL-only alias.
    expect(xml).toContain('operaton:delegateExpression="${chargeService}"');
    expect(xml).not.toContain('operaton:delegate=');

    // Direction 2 — XML → DSL: the importer reads `delegateExpression` back
    // to the same binding kind, and the printer emits the friendly `delegate`
    // alias, never the raw XML attribute name.
    expect(findServiceTask(irImported).binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
    expect(reemittedDsl).toContain('delegate = "${chargeService}"');
    expect(reemittedDsl).not.toContain('delegateExpression');
  });

  it('the re-emitted DSL re-parses with zero errors and re-desugars to the same binding', async () => {
    const irFinal = astToIr(await parseToAst(reemittedDsl));
    expect(findServiceTask(irFinal).binding).toEqual({
      kind: 'delegateExpression',
      expression: '${chargeService}',
    });
  });
});

// ===========================================================================
// `external` task.
// ===========================================================================

describe('round-trip: `external` task with a `topic`', () => {
  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(EXTERNAL_TASK_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars to an `external` binding carrying the topic', () => {
    expect(findServiceTask(irInitial).binding).toEqual({
      kind: 'external',
      topic: 'print-label',
    });
  });

  it('generates `operaton:type="external"` and `operaton:topic` in the BPMN XML', () => {
    expect(xml).toContain('operaton:type="external"');
    expect(xml).toContain('operaton:topic="print-label"');
  });

  it('re-imports to the same `external` binding', () => {
    expect(findServiceTask(irImported).binding).toEqual({
      kind: 'external',
      topic: 'print-label',
    });
  });

  it('re-emits `external … { topic = "…" }` and re-parses with zero errors', async () => {
    expect(reemittedDsl).toContain('external PrintLabel');
    expect(reemittedDsl).toContain('topic = "print-label"');
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ===========================================================================
// `script` task with a fenced body.
// ===========================================================================

describe('round-trip: `script` task with a fenced body', () => {
  const EXPECTED_CODE =
    'var discount = amount * 0.1;\n' +
    'execution.setVariable("discount", discount);\n';

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(SCRIPT_TASK_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars the `js` fence tag to canonical scriptFormat "javascript" and keeps the body verbatim', () => {
    const scriptTask = findScriptTask(irInitial);
    expect(scriptTask.format).toBe('javascript');
    expect(scriptTask.code).toBe(EXPECTED_CODE);
  });

  it('generates `scriptFormat="javascript"` and the script body in the BPMN XML', () => {
    expect(xml).toContain('scriptFormat="javascript"');
    expect(xml).toContain('var discount = amount * 0.1;');
  });

  it('re-imports to the same scriptFormat and body', () => {
    const scriptTask = findScriptTask(irImported);
    expect(scriptTask.format).toBe('javascript');
    expect(scriptTask.code).toBe(EXPECTED_CODE);
  });

  it('re-emits a fenced `script … ```javascript … ``` ` block and re-parses with zero errors', async () => {
    expect(reemittedDsl).toContain(
      `script ComputeDiscount \`\`\`javascript\n${EXPECTED_CODE}\`\`\``,
    );
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});
