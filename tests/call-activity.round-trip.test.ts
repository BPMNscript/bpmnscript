// Single-stage tests cannot catch a field-name or ordering disagreement between
// stages, such as the generator writing operaton:in/out in one order and the
// importer reconstructing another.

import { describe, it, expect } from 'vitest';

import type {
  BpmnProcess,
  FlowContainer,
  CallActivity,
} from '@bpmn-script/transform';

import {
  camundaAliasWarning,
  describeImportFirst,
} from './helpers/import-first.js';
import { normalizeIr } from './helpers/normalize-ir.js';
import { subProcess } from './helpers/ir-query.js';
import { roundTrip, validate } from './helpers/pipeline.js';

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

const inProcess = (name: string, body: string[], vars: string[] = []) =>
  [
    `process ${name} {`,
    ...vars.map((v) => `  var ${v}`),
    '  start Start',
    ...body,
    '  end End',
    '}',
    '',
  ].join('\n');

const CALL = {
  kind: 'callActivity',
  id: 'InvokeSub',
  calledElement: 'invoice-approval',
} as const;

describe('a call activity keeps its settings, mappings and position through every hop', () => {
  it.each<
    [
      title: string,
      source: string,
      path: string[],
      expected: CallActivity,
      written: string[],
      notWritten: string[],
      printed: string,
    ]
  >([
    [
      'no binding writes no binding attributes',
      inProcess('call-binding', [
        '  call InvokeSub(process: "invoice-approval")',
      ]),
      [],
      { ...CALL, binding: undefined },
      ['calledElement="invoice-approval"'],
      ['calledElementBinding', 'calledElementVersion', 'extensionElements'],
      '  call InvokeSub(process: "invoice-approval")\n',
    ],
    [
      'a deployment binding writes the binding and no version',
      inProcess('call-binding', [
        '  call InvokeSub(process: "invoice-approval", binding: deployment)',
      ]),
      [],
      { ...CALL, binding: { kind: 'deployment' } },
      ['operaton:calledElementBinding="deployment"'],
      ['calledElementVersion'],
      '  call InvokeSub(process: "invoice-approval", binding: deployment)\n',
    ],
    [
      'a pinned version writes the version binding and its number',
      inProcess('call-binding', [
        '  call InvokeSub(process: "invoice-approval", version: 3)',
      ]),
      [],
      { ...CALL, binding: { kind: 'version', version: '3' } },
      [
        'operaton:calledElementBinding="version"',
        'operaton:calledElementVersion="3"',
      ],
      [],
      '  call InvokeSub(process: "invoice-approval", version: 3)\n',
    ],
    [
      // `in` sources are checked against caller scope, `out` sources are not.
      'a businessKey and every mapping shape',
      inProcess(
        'call-full-featured',
        [
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
        ],
        ['a: number', 'b: number', 'w: string'],
      ),
      [],
      {
        ...CALL,
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
      },
      [],
      [],
      [
        '  call InvokeSub(process: "invoice-approval", binding: latest, businessKey: "${orderId}") {',
        '    in *',
        '    in x',
        '    in t = "${a + b}"',
        '    in t2 = "${a.b}"',
        '    in local v = w',
        '    out y',
        '    out z = calleeVar',
        '  }\n',
      ].join('\n'),
    ],
    [
      // `asyncBefore` pins the mapper's printed position on both sides.
      'a mapper class beside declared mappings',
      inProcess(
        'call-variable-mapper',
        [
          '  call InvokeSub(process: "invoice-approval", mapper: "com.acme.CallMapper", asyncBefore: true) {',
          '    in invoiceAmount = amount',
          '    out approved',
          '  }',
        ],
        ['amount: number'],
      ),
      [],
      {
        ...CALL,
        mapper: { kind: 'class', className: 'com.acme.CallMapper' },
        asyncBefore: true,
        inMappings: [
          { kind: 'variable', source: 'amount', target: 'invoiceAmount' },
        ],
        outMappings: [
          { kind: 'variable', source: 'approved', target: 'approved' },
        ],
      },
      ['operaton:variableMappingClass="com.acme.CallMapper"'],
      [],
      '  call InvokeSub(process: "invoice-approval", mapper: "com.acme.CallMapper", asyncBefore: true) {\n',
    ],
    [
      'a mapper delegate beside declared mappings',
      inProcess(
        'call-variable-mapper',
        [
          '  call InvokeSub(process: "invoice-approval", mapperDelegate: "${callMapperBean}", asyncBefore: true) {',
          '    in invoiceAmount = amount',
          '    out approved',
          '  }',
        ],
        ['amount: number'],
      ),
      [],
      {
        ...CALL,
        mapper: {
          kind: 'delegateExpression',
          expression: '${callMapperBean}',
        },
        asyncBefore: true,
        inMappings: [
          { kind: 'variable', source: 'amount', target: 'invoiceAmount' },
        ],
        outMappings: [
          { kind: 'variable', source: 'approved', target: 'approved' },
        ],
      },
      ['operaton:variableMappingDelegateExpression="${callMapperBean}"'],
      [],
      '  call InvokeSub(process: "invoice-approval", mapperDelegate: "${callMapperBean}", asyncBefore: true) {\n',
    ],
    [
      'a call nested in a subprocess stays in it, never in the parent',
      inProcess('call-in-subprocess', [
        '  subprocess Payment(label: "Handle payment") {',
        '    call InvokeSub(process: "invoice-approval") {',
        '      in *',
        '    }',
        '  }',
      ]),
      ['Payment'],
      { ...CALL, inMappings: [{ kind: 'all' }] },
      [],
      [],
      [
        '  subprocess Payment(label: "Handle payment") {',
        '    call InvokeSub(process: "invoice-approval") {',
        '      in *',
        '    }',
        '  }\n',
      ].join('\n'),
    ],
    [
      'a goto and a fall-through converging on the call',
      inProcess(
        'call-goto-demo',
        [
          '  if (flag) {',
          '    goto InvokeSub',
          '  }',
          '  user Prep(label: "Prepare", assignee: "demo")',
          '  call InvokeSub(process: "invoice-approval")',
        ],
        ['flag: boolean'],
      ),
      [],
      CALL,
      [],
      [],
      [
        '  if (flag) {',
        '    goto InvokeSub',
        '  }',
        '  user Prep(label: "Prepare", assignee: "demo")',
        '  call InvokeSub(process: "invoice-approval")\n',
      ].join('\n'),
    ],
  ])(
    '%s',
    async (_title, source, path, expected, written, notWritten, printed) => {
      const { diagnostics } = await validate(source);
      expect(diagnostics).toEqual([]);

      const run = await roundTrip(source);
      const callIn = (ir: BpmnProcess) => {
        expect(ir.flowElements.some((fe) => fe.id === 'InvokeSub')).toBe(
          path.length === 0,
        );
        return findCallActivity(
          path.reduce<FlowContainer>(subProcess, ir),
          'InvokeSub',
        );
      };
      expect(callIn(run.ir1)).toEqual(expected);
      for (const attribute of written) expect(run.xml).toContain(attribute);
      for (const attribute of notWritten) {
        expect(run.xml).not.toContain(attribute);
      }
      expect(run.warnings).toEqual([]);
      expect(callIn(run.ir2)).toEqual(callIn(run.ir1));
      expect(run.dsl).toContain(printed);
      expect(normalizeIr(run.ir3)).toEqual(normalizeIr(run.ir1));
      const { diagnostics: printedDiagnostics } = await validate(run.dsl);
      expect(printedDiagnostics).toEqual([]);
    },
  );
});

// The `name` differs from the one humanized from the id, so it survives as a label.
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

  <bpmn:process id="call-import-demo" isExecutable="true" operaton:historyTimeToLive="P30D">

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
    it('imports the alias binding and the interleaved mappings, and prints all `in`s before all `out`s', () => {
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
