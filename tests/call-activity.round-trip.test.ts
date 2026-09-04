// Single-stage tests cannot catch a field-name or ordering disagreement between
// stages, such as the generator writing operaton:in/out in one order and the
// importer reconstructing another. This runs the whole pipeline instead.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, irToDsl, astToIr } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  CallActivity,
  ImportWarning,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { idsOf, subProcess as findSubProcess } from './helpers/ir-query.js';
import {
  parse,
  parseToAst,
  roundTrip,
  roundTripOf,
  validate,
} from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PURCHASING_EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/purchasing.bpmnscript',
);

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

  const run = roundTripOf(MINIMAL_CALL_SRC);

  it('desugars to a callActivity carrying only calledElement', () => {
    const call = findCallActivity(run.ir1, 'InvokeSub');
    expect(call.calledElement).toBe('invoice-approval');
    expect(call.binding).toBeUndefined();
    expect(call.businessKey).toBeUndefined();
    expect(call.inMappings).toBeUndefined();
    expect(call.outMappings).toBeUndefined();
  });

  it('generates calledElement and NO binding attributes and NO extensionElements', () => {
    expect(run.xml).toContain('calledElement="invoice-approval"');
    expect(run.xml).not.toContain('calledElementBinding');
    expect(run.xml).not.toContain('calledElementVersion');
    expect(run.xml).not.toContain('extensionElements');
  });

  it('re-emits the same one-attribute call and re-parses with zero errors', async () => {
    expect(run.dsl).toContain(
      'call InvokeSub { process = "invoice-approval" }',
    );
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

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

  const run = roundTripOf(DEPLOYMENT_BINDING_SRC);

  it('desugars `binding = deployment` to { kind: "deployment" }', () => {
    expect(findCallActivity(run.ir1, 'InvokeSub').binding).toEqual({
      kind: 'deployment',
    });
  });

  it('generates operaton:calledElementBinding="deployment" and no version attribute', () => {
    expect(run.xml).toContain('operaton:calledElementBinding="deployment"');
    expect(run.xml).not.toContain('calledElementVersion');
  });

  it('re-imports to the same binding and re-emits `binding = deployment`', async () => {
    expect(findCallActivity(run.ir2, 'InvokeSub').binding).toEqual({
      kind: 'deployment',
    });
    expect(run.dsl).toContain('binding = deployment');
    const document = await parse(run.dsl);
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

  const run = roundTripOf(PINNED_VERSION_SRC);

  it('desugars `version = 3` to { kind: "version", version: "3" }', () => {
    expect(findCallActivity(run.ir1, 'InvokeSub').binding).toEqual({
      kind: 'version',
      version: '3',
    });
  });

  it('generates calledElementBinding="version" and calledElementVersion="3"', () => {
    expect(run.xml).toContain('operaton:calledElementBinding="version"');
    expect(run.xml).toContain('operaton:calledElementVersion="3"');
  });

  it('re-imports to the same binding and re-emits `version = 3`', async () => {
    expect(findCallActivity(run.ir2, 'InvokeSub').binding).toEqual({
      kind: 'version',
      version: '3',
    });
    expect(run.dsl).toContain('version = 3');
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: call activity — businessKey and every mapping shape', () => {
  // The validator checks `in` sources against caller scope, so they are declared
  // below. `out` sources are evaluated in the called process and are not.
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

  const run = roundTripOf(FULL_FEATURED_SRC);

  it('desugars to the expected call node (businessKey + every mapping shape)', () => {
    expect(findCallActivity(run.ir1, 'InvokeSub')).toEqual(EXPECTED_CALL);
  });

  it('imports with zero warnings, and the call node survives verbatim', () => {
    expect(run.warnings).toEqual([]);
    expect(findCallActivity(run.ir2, 'InvokeSub')).toEqual(
      findCallActivity(run.ir1, 'InvokeSub'),
    );
  });

  it('a second round-trip (DSL′ → IR₃) is normalized-equal to the first', () => {
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
  });

  it('the decompiled DSL recompiles without validation errors', async () => {
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});

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

  const run = roundTripOf(NESTED_CALL_SRC);

  it('the call sits in the nested Payment container, never in the parent, at every hop', () => {
    for (const ir of [run.ir1, run.ir2, run.ir3]) {
      expect(idsOf(ir).has('ChargeCustomer')).toBe(false);
      const payment = findSubProcess(ir, 'Payment');
      const call = findCallActivity(payment, 'ChargeCustomer');
      expect(call.calledElement).toBe('invoice-approval');
    }
  });

  it('the re-emitted DSL reconstructs the nested `subprocess { call … }` shape and re-parses cleanly', async () => {
    expect(run.dsl).toContain('subprocess Payment "Handle payment" {');
    expect(run.dsl).toContain('call ChargeCustomer');
    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

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

  const run = roundTripOf(GOTO_CALL_SRC);

  it('the fixture opens validator-clean (no diagnostics)', async () => {
    const { diagnostics } = await validate(GOTO_CALL_SRC);
    expect(diagnostics).toEqual([]);
  });

  it('both the goto branch and the fallthrough converge on the call node', () => {
    for (const ir of [run.ir1, run.ir2]) {
      expect(findCallActivity(ir, 'Invoke').calledElement).toBe(
        'invoice-approval',
      );
      const incoming = ir.sequenceFlows.filter((f) => f.targetRef === 'Invoke');
      expect(incoming.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('a second round-trip (DSL′ → IR₃) is normalized-equal to the first, and re-parses with zero errors', async () => {
    // irToDsl reconstructs the goto/fallthrough convergence as `if`/`else`
    // rather than replaying the literal `goto`, and re-desugaring that grows a
    // pass-through join, so compare through normalizeIr.
    expect(findCallActivity(run.ir3, 'Invoke').calledElement).toBe(
      'invoice-approval',
    );
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));

    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

describe('round-trip: import-first — interleaved mappings and the camunda: binding alias', () => {
  // The `name` differs from the name humanised from the id, so it survives as a
  // real label instead of being dropped as derivable.
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
  let importWarnings: ImportWarning[];
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
    const run = await roundTrip(source);
    expect(findCallActivity(run.ir1, 'ReviewInvoice').calledElement).toBe(
      'invoice-approval',
    );
    expect(run.xml).toContain('calledElement="invoice-approval"');
    expect(run.warnings).toEqual([]);

    const document = await parse(run.dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});
