// Single-stage tests cannot catch a field-name or ordering disagreement between
// stages, such as the generator writing operaton:in/out in one order and the
// importer reconstructing another. This runs the whole pipeline instead.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  FlowContainer,
  CallActivity,
  CallVariableMapper,
} from '@bpmn-script/transform';

import {
  camundaAliasWarning,
  describeImportFirst,
} from './helpers/import-first.js';
import { normalizeIr } from './helpers/normalize-ir.js';
import { idsOf, subProcess as findSubProcess } from './helpers/ir-query.js';
import { roundTrip, roundTripOf, validate } from './helpers/pipeline.js';

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

// `[what the call carries, the authored and printed settings after `process`,
// the IR binding, the Operaton attributes the XML carries, the ones it must not]`.
const BINDING_ROWS: readonly [
  string,
  string,
  CallActivity['binding'],
  readonly string[],
  readonly string[],
][] = [
  [
    'no binding',
    '',
    undefined,
    ['calledElement="invoice-approval"'],
    ['calledElementBinding', 'calledElementVersion', 'extensionElements'],
  ],
  [
    'a deployment binding',
    ', binding: deployment',
    { kind: 'deployment' },
    ['operaton:calledElementBinding="deployment"'],
    ['calledElementVersion'],
  ],
  [
    'a pinned version',
    ', version: 3',
    { kind: 'version', version: '3' },
    [
      'operaton:calledElementBinding="version"',
      'operaton:calledElementVersion="3"',
    ],
    [],
  ],
];

describe.each(BINDING_ROWS)(
  'round-trip: a call with %s',
  (_label, settings, binding, written, notWritten) => {
    const CALL = `call InvokeSub(process: "invoice-approval"${settings})`;

    const run = roundTripOf(
      [
        'process call-binding {',
        '  start Start',
        `  ${CALL}`,
        '  end End',
        '}',
        '',
      ].join('\n'),
    );

    it('desugars to the binding alone, writes exactly its attributes, and prints the call back', () => {
      expect(findCallActivity(run.ir1, 'InvokeSub')).toEqual({
        kind: 'callActivity',
        id: 'InvokeSub',
        calledElement: 'invoice-approval',
        binding,
      });
      for (const attribute of written) expect(run.xml).toContain(attribute);
      for (const attribute of notWritten) {
        expect(run.xml).not.toContain(attribute);
      }
      expect(run.warnings).toEqual([]);
      expect(findCallActivity(run.ir2, 'InvokeSub')).toEqual(
        findCallActivity(run.ir1, 'InvokeSub'),
      );
      expect(run.dsl).toContain(CALL);
    });
  },
);

describe('round-trip: call activity with businessKey and every mapping shape', () => {
  // The validator checks `in` sources against caller scope, so they are declared
  // below. `out` sources are evaluated in the called process and are not.
  const FULL_FEATURED_SRC = [
    'process call-full-featured {',
    '  var a: number',
    '  var b: number',
    '  var w: string',
    '',
    '  start Start',
    '  call InvokeSub(',
    '    process: "invoice-approval",',
    '    binding: latest,',
    '    businessKey: "${orderId}"',
    '  ) {',
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

  it("a second round-trip (DSL' -> IR3) is normalized-equal to the first", () => {
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
  });

  it('the decompiled DSL recompiles without validation errors', async () => {
    const { diagnostics } = await validate(run.dsl);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});

// `[what the call carries, the authored and printed setting, the IR mapper, the
// Operaton attribute]`. The setting column serves both the source and the
// re-emitted DSL, which is what makes a printing change visible here.
const MAPPER_ROWS: readonly [string, string, CallVariableMapper, string][] = [
  [
    'a mapper class',
    'mapper: "com.acme.CallMapper"',
    { kind: 'class', className: 'com.acme.CallMapper' },
    'operaton:variableMappingClass="com.acme.CallMapper"',
  ],
  [
    'a mapper delegate',
    'mapperDelegate: "${callMapperBean}"',
    { kind: 'delegateExpression', expression: '${callMapperBean}' },
    'operaton:variableMappingDelegateExpression="${callMapperBean}"',
  ],
];

describe.each(MAPPER_ROWS)(
  'round-trip: call activity with %s beside its declared mappings',
  (_label, mapperSetting, mapper, mapperAttr) => {
    // `asyncBefore` is here so the printed position is pinned on both sides: a
    // mapper that printed after the engine settings would still satisfy an
    // assertion that only pinned what precedes it.
    const CALL_HEAD = `call InvokeSub(process: "invoice-approval", ${mapperSetting}, asyncBefore: true) {`;

    const MAPPER_SRC = [
      'process call-variable-mapper {',
      '  var amount: number',
      '',
      '  start Start',
      `  ${CALL_HEAD}`,
      '    in invoiceAmount = amount',
      '    out approved',
      '  }',
      '  end End',
      '}',
      '',
    ].join('\n');

    const EXPECTED_CALL: CallActivity = {
      kind: 'callActivity',
      id: 'InvokeSub',
      calledElement: 'invoice-approval',
      mapper,
      asyncBefore: true,
      inMappings: [
        { kind: 'variable', source: 'amount', target: 'invoiceAmount' },
      ],
      outMappings: [
        { kind: 'variable', source: 'approved', target: 'approved' },
      ],
    };

    const run = roundTripOf(MAPPER_SRC);

    it('the mapper survives all four hops beside the declared mappings', () => {
      expect(findCallActivity(run.ir1, 'InvokeSub')).toEqual(EXPECTED_CALL);
      expect(run.xml).toContain(mapperAttr);
      expect(run.warnings).toEqual([]);
      expect(findCallActivity(run.ir2, 'InvokeSub')).toEqual(
        findCallActivity(run.ir1, 'InvokeSub'),
      );
      expect(run.dsl).toContain(CALL_HEAD);
      expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
    });

    it('the decompiled DSL recompiles without validation errors', async () => {
      const { diagnostics } = await validate(run.dsl);
      expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
    });
  },
);

describe('round-trip: call activity nested inside a subprocess', () => {
  const NESTED_CALL_SRC = [
    'process call-in-subprocess {',
    '  start Start',
    '  subprocess Payment(label: "Handle payment") {',
    '    call ChargeCustomer(process: "invoice-approval") {',
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

  it('the re-emitted DSL reconstructs the nested `subprocess { call ... }` shape', () => {
    expect(run.dsl).toContain('subprocess Payment(label: "Handle payment") {');
    expect(run.dsl).toContain('call ChargeCustomer');
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
    '  user Prep(label: "Prepare", assignee: "demo")',
    '  call Invoke(process: "invoice-approval")',
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

  it("a second round-trip (DSL' -> IR3) is normalized-equal to the first", () => {
    // irToDsl reconstructs the goto/fallthrough convergence as `if`/`else`
    // rather than replaying the literal `goto`, and re-desugaring that grows a
    // pass-through join, so compare through normalizeIr.
    expect(findCallActivity(run.ir3, 'Invoke').calledElement).toBe(
      'invoice-approval',
    );
    expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
  });
});

// The `name` differs from the name humanized from the id, so it survives as a
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

describeImportFirst(
  'interleaved mappings and the camunda: binding alias',
  HANDWRITTEN_BPMN,
  (first) => {
    it('imports the alias binding and the interleaved mappings', () => {
      const call = findCallActivity(first.ir, 'ReviewApprovalCall');
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

    it('the emitted call canonically reorders (all `in`s, then all `out`s) and keeps the alias-normalized binding', () => {
      expect(first.dsl).toContain(
        'call ReviewApprovalCall(label: "Get invoice sign-off", ' +
          'process: "invoice-approval", binding: deployment, ' +
          'businessKey: "${orderId}") {\n' +
          '    in invoiceAmount = amount\n' +
          '    in doubledAmount = "${amount * 2}"\n' +
          '    out wasApproved = approved\n' +
          '    out approvedFlag = "${approved ? 1 : 0}"\n' +
          '  }',
      );
    });
  },
  [camundaAliasWarning('call-import-demo')],
);

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
  });
});
