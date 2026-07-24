/**
 * Whole-feature E2E: `call` activity round-trip.
 *
 * The `call` construct (a leaf `bpmn:CallActivity` invoking another process by
 * id, with a version-resolution binding, a business key, and `in`/`out`
 * variable mappings) is fully implemented and merged; each single-stage
 * transform already has its own focused unit tests. What none of those catch
 * on its own is a field-name or ordering disagreement BETWEEN stages — e.g.
 * the generator writing `operaton:in`/`operaton:out` in one order and the
 * importer reconstructing a different one. This file drives the construct
 * through the full, unmocked pipeline
 *
 *   DSL → astToIr → irToXml → xmlToIr → irToDsl → (re-parse) → astToIr
 *
 * over real Langium parsing/validation, real `bpmn-moddle`, and real
 * `bpmn-auto-layout` (invoked inside `irToXml`). There is no Docker and no
 * engine here.
 *
 * Five cases:
 *
 *   1. Minimal — a `call` naming only `process`: the XML carries
 *      `calledElement` and nothing else (no binding attributes, no
 *      `extensionElements`), and the re-emitted DSL is the same one-attribute
 *      call.
 *   2. Full-featured — the three `CalledElementBinding` kinds (`deployment`,
 *      pinned `version`, `latest`) and every mapping shape (`*`, same-name
 *      shorthand, an operator expression, a quoted-raw expression, a `local`
 *      mapping, and a plain-copy `out`), asserting the call node survives an
 *      import verbatim and a second round-trip is normalized-equal.
 *   3. Composition with nesting — a `call` inside a `subprocess` body stays in
 *      the nested container at every hop.
 *   4. Goto interplay — a `goto` targeting a `call` step converges correctly
 *      and the program stays validator-clean.
 *   5. Import-first direction — a handwritten `.bpmn` fixture with
 *      interleaved `operaton:in`/`operaton:out` order and the
 *      `camunda:calledElementBinding` alias imports, reconstructs, and
 *      re-desugars to the same normalized IR (proving both the canonical
 *      reorder and the namespace-alias normalization).
 *
 * A final section exercises the example process added alongside this file
 * (`examples/spring-boot/processes/purchasing.bpmnscript`), asserting it is
 * validator-clean and that its `call` resolves the real neighbouring
 * `invoice-approval` example by id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
  CallActivity,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors round-trip.test.ts / new-constructs.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The example process added alongside this test. */
const PURCHASING_EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/purchasing.bpmnscript',
);

// ---------------------------------------------------------------------------
// Langium services — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
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

// ---------------------------------------------------------------------------
// Small container helpers (mirrors nested-subprocess.round-trip.test.ts).
// ---------------------------------------------------------------------------

/** Find the call-activity flow element with the given id in a container's own array. */
function findCallActivity(container: FlowContainer, id: string): CallActivity {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'callActivity' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'callActivity') {
    throw new Error(
      `expected a callActivity '${id}' in container '${container.id}'`,
    );
  }
  return el;
}

/** Find the sub-process element with the given id in a container's own array. */
function findSubProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(
      `expected a sub-process '${id}' in container '${container.id}'`,
    );
  }
  return el;
}

/** The set of flow-element ids directly held by a container. */
function idsOf(container: FlowContainer): Set<string> {
  return new Set(container.flowElements.map((fe) => fe.id));
}

// ===========================================================================
// 1. Minimal — `call <id> { process = "…" }`.
// ===========================================================================

describe('round-trip: minimal call (process only)', () => {
  const MINIMAL_CALL_SRC = [
    'process minimal-call {',
    '  start Start',
    '  call InvokeSub {',
    '    process = "invoice-approval"',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(MINIMAL_CALL_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars to a callActivity carrying only calledElement', () => {
    const call = findCallActivity(irInitial, 'InvokeSub');
    expect(call.calledElement).toBe('invoice-approval');
    expect(call.binding).toBeUndefined();
    expect(call.businessKey).toBeUndefined();
    expect(call.inMappings).toBeUndefined();
    expect(call.outMappings).toBeUndefined();
  });

  it('generates calledElement and NO binding attributes and NO extensionElements', () => {
    expect(xml).toContain('calledElement="invoice-approval"');
    expect(xml).not.toContain('calledElementBinding');
    expect(xml).not.toContain('calledElementVersion');
    expect(xml).not.toContain('extensionElements');
  });

  it('re-emits the same one-attribute call and re-parses with zero errors', async () => {
    expect(reemittedDsl).toContain(
      'call InvokeSub { process = "invoice-approval" }',
    );
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ===========================================================================
// 2. Full-featured.
// ===========================================================================

describe('round-trip: call activity — deployment binding', () => {
  const DEPLOYMENT_BINDING_SRC = [
    'process call-deployment-binding {',
    '  start Start',
    '  call InvokeSub {',
    '    process = "invoice-approval"',
    '    binding = deployment',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(DEPLOYMENT_BINDING_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars `binding = deployment` to { kind: "deployment" }', () => {
    expect(findCallActivity(irInitial, 'InvokeSub').binding).toEqual({
      kind: 'deployment',
    });
  });

  it('generates operaton:calledElementBinding="deployment" and no version attribute', () => {
    expect(xml).toContain('operaton:calledElementBinding="deployment"');
    expect(xml).not.toContain('calledElementVersion');
  });

  it('re-imports to the same binding and re-emits `binding = deployment`', async () => {
    expect(findCallActivity(irImported, 'InvokeSub').binding).toEqual({
      kind: 'deployment',
    });
    expect(reemittedDsl).toContain('binding = deployment');
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: call activity — pinned version', () => {
  const PINNED_VERSION_SRC = [
    'process call-pinned-version {',
    '  start Start',
    '  call InvokeSub {',
    '    process = "invoice-approval"',
    '    version = 3',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let reemittedDsl: string;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(PINNED_VERSION_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    reemittedDsl = irToDsl(irImported);
  });

  it('desugars `version = 3` to { kind: "version", version: "3" }', () => {
    expect(findCallActivity(irInitial, 'InvokeSub').binding).toEqual({
      kind: 'version',
      version: '3',
    });
  });

  it('generates calledElementBinding="version" and calledElementVersion="3"', () => {
    expect(xml).toContain('operaton:calledElementBinding="version"');
    expect(xml).toContain('operaton:calledElementVersion="3"');
  });

  it('re-imports to the same binding and re-emits `version = 3`', async () => {
    expect(findCallActivity(irImported, 'InvokeSub').binding).toEqual({
      kind: 'version',
      version: '3',
    });
    expect(reemittedDsl).toContain('version = 3');
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: call activity — businessKey and every mapping shape', () => {
  // `a`, `b`, `w` are the caller-scope variables the `in` sources below
  // reference (`in` sources are checked by the validator; `out` sources are
  // evaluated in the CALLED process's scope and need no caller declaration).
  const FULL_FEATURED_SRC = [
    'process call-full-featured {',
    '  var a: number',
    '  var b: number',
    '  var w: string',
    '',
    '  start Start',
    '  call InvokeSub {',
    '    process = "invoice-approval"',
    '    binding = latest',
    '    businessKey = "${orderId}"',
    '    in *',
    '    in x',
    '    in t = a + b',
    '    in t2 = "${a.b}"',
    '    in local v = w',
    '    out y',
    '    out z = calleeVar',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  const EXPECTED_CALL: CallActivity = {
    kind: 'callActivity',
    id: 'InvokeSub',
    calledElement: 'invoice-approval',
    binding: { kind: 'latest' },
    businessKey: '${orderId}',
    inMappings: [
      { kind: 'all' },
      { kind: 'variable', source: 'x', target: 'x' },
      { kind: 'expression', sourceExpression: '${a + b}', target: 't' },
      { kind: 'expression', sourceExpression: '${a.b}', target: 't2' },
      { kind: 'variable', source: 'w', target: 'v', local: true },
    ],
    outMappings: [
      { kind: 'variable', source: 'y', target: 'y' },
      { kind: 'variable', source: 'calleeVar', target: 'z' },
    ],
  };

  let irInitial: BpmnProcess;
  let xml: string;
  let importWarnings: string[];
  let irImported: BpmnProcess;
  let dslPrime: string;
  let irSecondRound: BpmnProcess;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(FULL_FEATURED_SRC));
    xml = await irToXml(irInitial);
    const imported = await xmlToIr(xml);
    importWarnings = imported.warnings;
    irImported = imported.ir;

    dslPrime = irToDsl(irImported);
    irSecondRound = astToIr(await parseToAst(dslPrime));
  });

  it('desugars to the expected call node (businessKey + every mapping shape)', () => {
    expect(findCallActivity(irInitial, 'InvokeSub')).toEqual(EXPECTED_CALL);
  });

  it('imports with zero warnings, and the call node survives verbatim', () => {
    expect(importWarnings).toEqual([]);
    expect(findCallActivity(irImported, 'InvokeSub')).toEqual(
      findCallActivity(irInitial, 'InvokeSub'),
    );
  });

  it('a second round-trip (DSL′ → IR₃) is normalized-equal to the first', () => {
    expect(normalizeIr(irSecondRound)).toEqual(normalizeIr(irInitial));
  });

  it('the decompiled DSL recompiles without validation errors', async () => {
    const { diagnostics } = await validate(dslPrime);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});

// ===========================================================================
// 3. Composition with nesting — a `call` inside a `subprocess` body.
// ===========================================================================

describe('round-trip: call activity nested inside a subprocess', () => {
  const NESTED_CALL_SRC = [
    'process call-in-subprocess {',
    '  start Start',
    '  subprocess Payment "Handle payment" {',
    '    call ChargeCustomer {',
    '      process = "invoice-approval"',
    '      in *',
    '    }',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let dslPrime: string;
  let irSecondRound: BpmnProcess;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(NESTED_CALL_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    dslPrime = irToDsl(irImported);
    irSecondRound = astToIr(await parseToAst(dslPrime));
  });

  it('the call sits in the nested Payment container, never in the parent, at every hop', () => {
    for (const ir of [irInitial, irImported, irSecondRound]) {
      expect(idsOf(ir).has('ChargeCustomer')).toBe(false);
      const payment = findSubProcess(ir, 'Payment');
      const call = findCallActivity(payment, 'ChargeCustomer');
      expect(call.calledElement).toBe('invoice-approval');
    }
  });

  it('the re-emitted DSL reconstructs the nested `subprocess { call … }` shape and re-parses cleanly', async () => {
    expect(dslPrime).toContain('subprocess Payment "Handle payment" {');
    expect(dslPrime).toContain('call ChargeCustomer');
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ===========================================================================
// 4. Goto interplay — a `goto` targeting a `call` step.
// ===========================================================================

describe('round-trip: goto targeting a call activity', () => {
  const GOTO_CALL_SRC = [
    'process call-goto-demo {',
    '  var flag: boolean',
    '',
    '  start Start',
    '  if (flag) {',
    '    goto Invoke',
    '  }',
    '  user Prep "Prepare" { assignee = "demo" }',
    '  call Invoke {',
    '    process = "invoice-approval"',
    '  }',
    '  end End',
    '}',
    '',
  ].join('\n');

  let irInitial: BpmnProcess;
  let xml: string;
  let irImported: BpmnProcess;
  let dslPrime: string;
  let irSecondRound: BpmnProcess;

  beforeAll(async () => {
    irInitial = astToIr(await parseToAst(GOTO_CALL_SRC));
    xml = await irToXml(irInitial);
    ({ ir: irImported } = await xmlToIr(xml));
    dslPrime = irToDsl(irImported);
    irSecondRound = astToIr(await parseToAst(dslPrime));
  });

  it('the fixture opens validator-clean (no diagnostics)', async () => {
    const { diagnostics } = await validate(GOTO_CALL_SRC);
    expect(diagnostics).toEqual([]);
  });

  it('both the goto branch and the fallthrough converge on the call node', () => {
    for (const ir of [irInitial, irImported]) {
      expect(findCallActivity(ir, 'Invoke').calledElement).toBe(
        'invoice-approval',
      );
      const incoming = ir.sequenceFlows.filter((f) => f.targetRef === 'Invoke');
      expect(incoming.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('a second round-trip (DSL′ → IR₃) is normalized-equal to the first, and re-parses with zero errors', async () => {
    // `irToDsl` reconstructs the goto/fallthrough convergence on `Invoke` as a
    // structured `if`/`else` (an empty true-branch, the fallthrough task in
    // the else) rather than replaying the literal `goto` — the same
    // structure-over-goto preference already exercised for other constructs.
    // Re-desugaring that structured form grows the documented synthesized
    // pass-through join (see `helpers/normalize-ir.ts`), so the comparison
    // goes through `normalizeIr` rather than a raw flow-endpoint diff.
    expect(findCallActivity(irSecondRound, 'Invoke').calledElement).toBe(
      'invoice-approval',
    );
    expect(normalizeIr(irSecondRound)).toEqual(normalizeIr(irInitial));

    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// ===========================================================================
// 5. Import-first direction — interleaved In/Out order + camunda: alias.
// ===========================================================================

describe('round-trip: import-first — interleaved mappings and the camunda: binding alias', () => {
  // Canonical namespaces of `tests/golden/invoice-approval-handwritten.bpmn`,
  // plus `camunda:` to exercise the `calledElementBinding` alias. The call's
  // `name` ("Get invoice sign-off") deliberately does NOT equal
  // `humanize('ReviewApprovalCall')` ("Review Approval Call"), so it is kept
  // as a genuine label rather than silently dropped as derivable.
  const HANDWRITTEN_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
    xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
    xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
    id="Definitions_1"
    targetNamespace="http://bpmn.io/schema/bpmn">

  <bpmn:process id="call-import-demo" isExecutable="true">

    <bpmn:startEvent id="Start">
      <bpmn:outgoing>Flow_Start_ReviewApprovalCall</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:callActivity
        id="ReviewApprovalCall"
        name="Get invoice sign-off"
        calledElement="invoice-approval"
        camunda:calledElementBinding="deployment">
      <bpmn:incoming>Flow_Start_ReviewApprovalCall</bpmn:incoming>
      <bpmn:outgoing>Flow_ReviewApprovalCall_End</bpmn:outgoing>
      <bpmn:extensionElements>
        <operaton:in businessKey="\${orderId}" />
        <operaton:out source="approved" target="wasApproved" />
        <operaton:in source="amount" target="invoiceAmount" />
        <operaton:out sourceExpression="\${approved ? 1 : 0}" target="approvedFlag" />
        <operaton:in sourceExpression="\${amount * 2}" target="doubledAmount" />
      </bpmn:extensionElements>
    </bpmn:callActivity>

    <bpmn:endEvent id="End">
      <bpmn:incoming>Flow_ReviewApprovalCall_End</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:sequenceFlow id="Flow_Start_ReviewApprovalCall" sourceRef="Start" targetRef="ReviewApprovalCall" />
    <bpmn:sequenceFlow id="Flow_ReviewApprovalCall_End" sourceRef="ReviewApprovalCall" targetRef="End" />

  </bpmn:process>
</bpmn:definitions>`;

  let irFirstImport: BpmnProcess;
  let importWarnings: string[];
  let dsl: string;
  let irSecondImport: BpmnProcess;

  beforeAll(async () => {
    const first = await xmlToIr(HANDWRITTEN_BPMN);
    irFirstImport = first.ir;
    importWarnings = first.warnings;
    dsl = irToDsl(irFirstImport);
    irSecondImport = astToIr(await parseToAst(dsl));
  });

  it('imports the alias binding and the interleaved mappings with zero warnings', () => {
    expect(importWarnings).toEqual([]);
    const call = findCallActivity(irFirstImport, 'ReviewApprovalCall');
    expect(call.binding).toEqual({ kind: 'deployment' });
    expect(call.inMappings).toEqual([
      { kind: 'variable', source: 'amount', target: 'invoiceAmount' },
      {
        kind: 'expression',
        sourceExpression: '${amount * 2}',
        target: 'doubledAmount',
      },
    ]);
    expect(call.outMappings).toEqual([
      { kind: 'variable', source: 'approved', target: 'wasApproved' },
      {
        kind: 'expression',
        sourceExpression: '${approved ? 1 : 0}',
        target: 'approvedFlag',
      },
    ]);
  });

  it('re-parsing and re-desugaring the emitted DSL is normalized-equal to the first import', () => {
    expect(normalizeIr(irSecondImport)).toEqual(normalizeIr(irFirstImport));
  });

  it('the emitted DSL line canonically reorders (all `in`s, then all `out`s) and keeps the alias-normalized binding', () => {
    expect(dsl).toContain(
      'call ReviewApprovalCall "Get invoice sign-off" { ' +
        'process = "invoice-approval" ' +
        'binding = deployment ' +
        'businessKey = "${orderId}" ' +
        'in invoiceAmount = amount ' +
        'in doubledAmount = "${amount * 2}" ' +
        'out wasApproved = approved ' +
        'out approvedFlag = "${approved ? 1 : 0}" }',
    );
  });
});

// ===========================================================================
// Example program: `examples/spring-boot/processes/purchasing.bpmnscript`.
// ===========================================================================

describe('example: purchasing.bpmnscript calls the invoice-approval example by id', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(PURCHASING_EXAMPLE_PATH, 'utf-8');
  });

  it('opens validator-clean (no diagnostics)', async () => {
    const { diagnostics } = await validate(source);
    expect(diagnostics).toEqual([]);
  });

  it('round-trips end to end and resolves the real invoice-approval example by id', async () => {
    const ir = astToIr(await parseToAst(source));
    const call = findCallActivity(ir, 'ReviewInvoice');
    expect(call.calledElement).toBe('invoice-approval');

    const xml = await irToXml(ir);
    expect(xml).toContain('calledElement="invoice-approval"');

    const { ir: irImported, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
    const reemittedDsl = irToDsl(irImported);
    const document = await parse(reemittedDsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});
