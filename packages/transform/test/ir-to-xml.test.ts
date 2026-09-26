/**
 * Every test runs the full serializer, `bpmn-auto-layout` included. Fixtures
 * are hand-built IR, so nothing here depends on the parser or the desugarer
 * except the golden diff, which runs the whole `parse -> astToIr -> irToXml`
 * pipeline.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpmnModdle } from 'bpmn-moddle';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import {
  createModdle,
  irToXml,
  HISTORY_TIME_TO_LIVE,
  SERVICE_TASK_LIKE_TAG,
} from '../src/ir-to-xml.js';
import { astToIr } from '../src/ast-to-ir.js';
import {
  around,
  boundaryEvent,
  builtinBinding,
  callActivity,
  chained,
  chainedSub,
  classBinding,
  conditionDef,
  delegateBinding,
  edge,
  errorDef,
  escalationDef,
  eventHandler,
  exprBinding,
  externalBinding,
  flowChain,
  gateway,
  HANDWRITTEN_IMPORT_IR,
  ioParam,
  messageDef,
  minimalProcess,
  processIr,
  scriptTask,
  signalDef,
  textValue,
  timerDef,
  triggeredSub,
  typedEvent,
} from './helpers/ir-fixtures.js';
import type {
  BpmnProcess,
  CatchEventDefinition,
  CodeBinding,
  EndEventDefinition,
  EventDefinition,
  FieldInjection,
  FlowElement,
  FormField,
  Gateway,
  LoopCharacteristics,
  ServiceTask,
  ServiceTaskBinding,
  VersionBinding,
} from '../src/ir/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_GENERATED_PATH = resolve(
  here,
  '../../../tests/golden/invoice-approval-generated.bpmn',
);
const EXAMPLE_BPMNSCRIPT_PATH = resolve(
  here,
  '../../../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const importShapedIr: BpmnProcess = {
  ...HANDWRITTEN_IMPORT_IR,
  name: 'Invoice Approval',
};

// ── Shared XML output ────────────────────────────────────────────────────────

let xml: string;

beforeAll(async () => {
  xml = await irToXml(importShapedIr);
});

describe('irToXml: import-shaped IR', () => {
  it('irToXml(importShapedIr) parses cleanly via bpmn-moddle.fromXML', async () => {
    await expectNoModdleWarnings(xml);
  });

  it('gives every node the incoming/outgoing children its IR edges call for', () => {
    // MIWG requires the children and bpmn-moddle does not derive them, so the
    // degree of every node is checked rather than the document-wide total.
    const degrees = Object.fromEntries(
      [
        'ReviewStart',
        'ReviewInvoice',
        'AmountCheck',
        'SeniorApproval',
        'AutoApprove',
        'Done',
      ].map((id) => [id, degreeOf(xml, id)]),
    );
    expect(degrees).toEqual({
      ReviewStart: { in: 0, out: 1 },
      ReviewInvoice: { in: 1, out: 1 },
      AmountCheck: { in: 1, out: 2 },
      SeniorApproval: { in: 1, out: 1 },
      AutoApprove: { in: 1, out: 1 },
      Done: { in: 2, out: 0 },
    });
  });
});

describe('irToXml: bpmn:Definitions id', () => {
  it('names bpmn:Definitions after the process id', async () => {
    const definitions = await parseDefinitionsWithOperaton(
      await irToXml(minimalProcess([{ kind: 'task', id: 'X' }])),
    );
    expect(definitions.id).toBe('Definitions_p');
  });

  it('resolves a collision against an authored element id and keeps the process element', async () => {
    const definitions = await parseDefinitionsWithOperaton(
      await irToXml(minimalProcess([{ kind: 'task', id: 'Definitions_p' }])),
    );
    expect(definitions.id).toBe('Definitions_p_2');
    expect(processOf(definitions).id).toBe('p');
  });

  it('throws naming the moddle-xml warning when two elements share an id', async () => {
    const dup = minimalProcess([
      { kind: 'task', id: 'X' },
      { kind: 'task', id: 'X' },
    ]);

    await expect(irToXml(dup)).rejects.toThrow(/duplicate ID/);
  });
});

describe('irToXml: full-pipeline golden diff', () => {
  let pipelineXml: string;

  beforeAll(async () => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    const parse = parseHelper<Model>(services.BpmnScript);

    const src = readFileSync(EXAMPLE_BPMNSCRIPT_PATH, 'utf-8');
    const document = await parse(src);
    if (document.parseResult.parserErrors.length > 0) {
      throw new Error(
        'Parser errors in example:\n' +
          document.parseResult.parserErrors.map((e) => e.message).join('\n'),
      );
    }

    const ir = astToIr(document.parseResult.value);
    pipelineXml = await irToXml(ir);
  });

  it('irToXml(astToIr(parse(example))) matches the generated golden byte-for-byte', () => {
    // The golden is what the engine E2E deploys, so this pins the whole engine
    // contract at once. The example holds no sub-process, so it also pins that
    // the DI expansion hint is attached only when one is present.
    const goldenXml = readFileSync(GOLDEN_GENERATED_PATH, 'utf-8');
    expect(pipelineXml).toBe(goldenXml);
  });
});

describe('irToXml: parallelGateway serialization', () => {
  const parallelIr: BpmnProcess = processIr(
    'parallel-proc',
    [
      { kind: 'startEvent', id: 'Start' },
      { kind: 'parallelGateway', id: 'Fork', name: 'Fork' },
      { kind: 'userTask', id: 'BranchA', name: 'Branch A' },
      { kind: 'userTask', id: 'BranchB', name: 'Branch B' },
      { kind: 'parallelGateway', id: 'Join', name: 'Join' },
      { kind: 'endEvent', id: 'End' },
    ],
    [
      { id: 'F_Start_Fork', sourceRef: 'Start', targetRef: 'Fork' },
      { id: 'F_Fork_A', sourceRef: 'Fork', targetRef: 'BranchA' },
      { id: 'F_Fork_B', sourceRef: 'Fork', targetRef: 'BranchB' },
      { id: 'F_A_Join', sourceRef: 'BranchA', targetRef: 'Join' },
      { id: 'F_B_Join', sourceRef: 'BranchB', targetRef: 'Join' },
      { id: 'F_Join_End', sourceRef: 'Join', targetRef: 'End' },
    ],
  );

  let parallelXml: string;

  beforeAll(async () => {
    parallelXml = await irToXml(parallelIr);
  });

  it('emits Fork and Join as bpmn:parallelGateway with their split/join degrees and no default', () => {
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Fork"/);
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Join"/);
    expect(degreeOf(parallelXml, 'Fork')).toEqual({ in: 1, out: 2 });
    expect(degreeOf(parallelXml, 'Join')).toEqual({ in: 2, out: 1 });
    expect(extractNodeBlock(parallelXml, 'Fork')).not.toContain('default=');
    expect(extractNodeBlock(parallelXml, 'Join')).not.toContain('default=');
  });
});

describe('irToXml: inclusive and event-based gateway serialization', () => {
  /** An inclusive fork with a default, an inclusive merge without, and a race. */
  const gatewaysIr: BpmnProcess = processIr(
    'gateways-proc',
    [
      { kind: 'startEvent', id: 'Start' },
      {
        kind: 'inclusiveGateway',
        id: 'Fork',
        name: 'Any that apply',
        defaultFlowId: 'F_Fork_C',
      },
      { kind: 'userTask', id: 'A' },
      { kind: 'userTask', id: 'B' },
      { kind: 'userTask', id: 'C' },
      { kind: 'inclusiveGateway', id: 'Merge' },
      { kind: 'eventBasedGateway', id: 'Race', name: 'First of' },
      typedEvent(
        'intermediateCatchEvent',
        'Wait1',
        timerDef('duration', 'PT5M'),
      ),
      typedEvent('intermediateCatchEvent', 'Wait2', messageDef('Cancelled')),
      { kind: 'exclusiveGateway', id: 'Settle' },
      { kind: 'endEvent', id: 'End' },
    ],
    [
      { id: 'F_Start_Fork', sourceRef: 'Start', targetRef: 'Fork' },
      {
        id: 'F_Fork_A',
        sourceRef: 'Fork',
        targetRef: 'A',
        conditionExpression: '${a}',
      },
      {
        id: 'F_Fork_B',
        sourceRef: 'Fork',
        targetRef: 'B',
        conditionExpression: '${b}',
      },
      { id: 'F_Fork_C', sourceRef: 'Fork', targetRef: 'C' },
      { id: 'F_A_Merge', sourceRef: 'A', targetRef: 'Merge' },
      { id: 'F_B_Merge', sourceRef: 'B', targetRef: 'Merge' },
      { id: 'F_C_Merge', sourceRef: 'C', targetRef: 'Merge' },
      { id: 'F_Merge_Race', sourceRef: 'Merge', targetRef: 'Race' },
      { id: 'F_Race_1', sourceRef: 'Race', targetRef: 'Wait1' },
      { id: 'F_Race_2', sourceRef: 'Race', targetRef: 'Wait2' },
      { id: 'F_1_Settle', sourceRef: 'Wait1', targetRef: 'Settle' },
      { id: 'F_2_Settle', sourceRef: 'Wait2', targetRef: 'Settle' },
      { id: 'F_Settle_End', sourceRef: 'Settle', targetRef: 'End' },
    ],
  );

  let gatewaysXml: string;

  beforeAll(async () => {
    gatewaysXml = await irToXml(gatewaysIr);
  });

  it('emits both tags under their own ids and names, with the default only where the IR carries one', () => {
    const openingTag = (id: string): string =>
      extractNodeBlock(gatewaysXml, id).split('\n')[0]!;
    // A synthesized id must not be humanized into a label.
    expect(['Fork', 'Merge', 'Race'].map(openingTag)).toEqual([
      '<bpmn:inclusiveGateway id="Fork" name="Any that apply" default="F_Fork_C">',
      '<bpmn:inclusiveGateway id="Merge">',
      '<bpmn:eventBasedGateway id="Race" name="First of">',
    ]);

    expect(degreeOf(gatewaysXml, 'Fork').out).toBe(3);
    expect(degreeOf(gatewaysXml, 'Merge').in).toBe(3);
    expect(degreeOf(gatewaysXml, 'Race').out).toBe(2);
  });

  it('writes the default a step carries, on the step', async () => {
    const stepDefault = processIr(
      'step-default',
      [
        { kind: 'startEvent', id: 'Start' },
        { kind: 'userTask', id: 'Triage', defaultFlowId: 'F_Triage_B' },
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
      ],
      [
        { id: 'F_Start_Triage', sourceRef: 'Start', targetRef: 'Triage' },
        {
          id: 'F_Triage_A',
          sourceRef: 'Triage',
          targetRef: 'A',
          conditionExpression: '${a}',
        },
        { id: 'F_Triage_B', sourceRef: 'Triage', targetRef: 'B' },
      ],
    );
    const xml = await irToXml(stepDefault);
    expect(extractNodeBlock(xml, 'Triage')).toContain('default="F_Triage_B"');
    await expectNoModdleWarnings(xml);
  });

  it('names the offending gateway kind when a declared default flow is missing', async () => {
    const danglingDefault = processIr('dangling-default', [
      { kind: 'inclusiveGateway', id: 'Fork', defaultFlowId: 'F_absent' },
    ]);

    await expect(irToXml(danglingDefault)).rejects.toThrow(
      /inclusiveGateway "Fork" declares default flow "F_absent"/,
    );
  });

  it('lays out every shape and every edge, and re-reads through moddle without a warning', async () => {
    await expectNoModdleWarnings(gatewaysXml);

    const shapes = await parseDiShapesById(gatewaysXml);
    for (const node of gatewaysIr.flowElements) {
      const bounds = requireShape(shapes, node.id).bounds;
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
    }
    expect((gatewaysXml.match(/<bpmndi:BPMNEdge/g) ?? []).length).toBe(
      gatewaysIr.sequenceFlows.length,
    );
  });
});

/** The `operaton:field` children `fields` serialize to, under a builtin binding. */
function builtinFieldsBlock(fields: FieldInjection[]): string {
  return fields
    .map((f) =>
      f.value.startsWith('${')
        ? `        <operaton:field name="${f.name}">\n          <operaton:expression>${f.value}</operaton:expression>\n        </operaton:field>\n`
        : `        <operaton:field name="${f.name}" stringValue="${f.value}" />\n`,
    )
    .join('');
}

/** The serialized tag of a `ServiceTask.element`: moddle writes the `$type` name with its first letter lowered. */
function serviceTaskLikeXmlTag(element: ServiceTask['element']): string {
  return SERVICE_TASK_LIKE_TAG[element ?? 'service'].replace(
    /:[A-Z]/,
    (prefixed) => prefixed.toLowerCase(),
  );
}

/** The whole block of the task `T` of {@link around}, with the given attributes and extension children. */
function taskBlock(
  element: ServiceTask['element'],
  attributes: string,
  extension = '',
): string {
  const tag = serviceTaskLikeXmlTag(element);
  return (
    `<${tag} id="T" name="T" ${attributes}>\n` +
    extension +
    '      <bpmn:incoming>F1</bpmn:incoming>\n' +
    '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
    `    </${tag}>`
  );
}

const MAIL_FIELDS: FieldInjection[] = [
  { name: 'to', value: 'ops@example.com' },
  { name: 'text', value: '${body}' },
];
const SHELL_FIELDS: FieldInjection[] = [
  { name: 'command', value: 'echo hi' },
  { name: 'arg1', value: '${input}' },
];

describe('irToXml: service-task-like tags and their bindings', () => {
  it.each<[string, Omit<ServiceTask, 'kind' | 'id'>, string, string?]>([
    [
      'a class binding writes operaton:class',
      { binding: classBinding('com.example.Run') },
      'operaton:class="com.example.Run"',
    ],
    [
      'an expression binding writes operaton:expression',
      { binding: exprBinding('${bean.method(execution)}') },
      'operaton:expression="${bean.method(execution)}"',
    ],
    [
      'a delegateExpression binding writes operaton:delegateExpression',
      { binding: delegateBinding('${myDelegate}') },
      'operaton:delegateExpression="${myDelegate}"',
    ],
    [
      'an external binding with a topic alone writes operaton:type and operaton:topic, no taskPriority and no extension block',
      { binding: externalBinding('shipping') },
      'operaton:type="external" operaton:topic="shipping"',
    ],
    [
      'a send task carries its binding under bpmn:sendTask',
      { element: 'send', binding: classBinding('com.example.Run') },
      'operaton:class="com.example.Run"',
    ],
    [
      'a business rule task carries its binding under bpmn:businessRuleTask',
      { element: 'businessRule', binding: classBinding('com.example.Run') },
      'operaton:class="com.example.Run"',
    ],
    [
      'a builtin mail binding writes operaton:type and its fields as extension children',
      { binding: builtinBinding('mail', MAIL_FIELDS) },
      'operaton:type="mail"',
      builtinFieldsBlock(MAIL_FIELDS),
    ],
    [
      'a builtin shell binding does the same under bpmn:businessRuleTask',
      {
        element: 'businessRule',
        binding: builtinBinding('shell', SHELL_FIELDS),
      },
      'operaton:type="shell"',
      builtinFieldsBlock(SHELL_FIELDS),
    ],
    [
      'a decision binding with no modifier writes decisionRef alone',
      {
        element: 'businessRule',
        binding: { kind: 'decision', decisionRef: 'riskRating' },
      },
      'operaton:decisionRef="riskRating"',
    ],
    [
      'a decision binding with a pinned version and a result mapping writes all four DMN attributes beside resultVariable',
      {
        element: 'businessRule',
        binding: {
          kind: 'decision',
          decisionRef: 'riskRating',
          binding: { kind: 'version', version: '3' },
          mapDecisionResult: 'singleEntry',
        },
        resultVariable: 'risk',
      },
      'operaton:resultVariable="risk" operaton:decisionRef="riskRating" operaton:decisionRefBinding="version" operaton:decisionRefVersion="3" operaton:mapDecisionResult="singleEntry"',
    ],
  ])('%s', async (_title, task, attributes, fields) => {
    const xml = await irToXml(
      around({ kind: 'serviceTask', id: 'T', ...task }),
    );
    expect(extractNodeBlock(xml, 'T')).toBe(
      taskBlock(
        task.element,
        attributes,
        fields === undefined
          ? ''
          : '      <bpmn:extensionElements>\n' +
              fields +
              '      </bpmn:extensionElements>\n',
      ),
    );
  });
});

/**
 * Read from a run once, then frozen: `properties` before the mappings, `name`
 * (not `id`) on a task's property, `errorRef` resolving to a synthesized root
 * for a code nothing declares or throws.
 */
const FROZEN_EXTERNAL_EXTRAS_BLOCK = `<bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="gateway" value="stripe" />
          <operaton:property name="currency" value="USD" />
        </operaton:properties>
        <operaton:errorEventDefinition errorRef="Error_DECLINED" expression="\${externalTask.errorMessage == &#34;declined&#34;}" />
        <operaton:errorEventDefinition errorRef="Error_TIMEOUT" expression="\${retries == 0}" />
      </bpmn:extensionElements>`;

describe('irToXml: external task extras', () => {
  const externalWithExtras: ServiceTaskBinding = {
    kind: 'external',
    topic: 'charge-card',
    taskPriority: '42',
    properties: [
      { key: 'gateway', value: 'stripe' },
      { key: 'currency', value: 'USD' },
    ],
    errorMappings: [
      {
        errorCode: 'DECLINED',
        condition: '${externalTask.errorMessage == "declined"}',
      },
      { errorCode: 'TIMEOUT', condition: '${retries == 0}' },
    ],
  };

  it('writes taskPriority beside type/topic, properties keyed by name, and one error root plus mapping per code, with nothing declared or throwing them', async () => {
    const xml = await irToXml(
      around({
        kind: 'serviceTask',
        id: 'Charge',
        binding: externalWithExtras,
      }),
    );

    expect(extractNodeBlock(xml, 'Charge')).toContain(
      'operaton:type="external" operaton:topic="charge-card" operaton:taskPriority="42"',
    );

    expect(extensionBlock(xml)).toBe(FROZEN_EXTERNAL_EXTRAS_BLOCK);

    const defs = await parseDefinitionsWithOperaton(xml);
    expect(rootsOfType(defs, 'bpmn:Error').map((r) => r.errorCode)).toEqual([
      'DECLINED',
      'TIMEOUT',
    ]);
  });

  it.each([['send'], ['businessRule']] as const)(
    'a %s task carries the same properties and mapping children under its own tag',
    async (element) => {
      const xml = await irToXml(
        around({
          kind: 'serviceTask',
          id: 'Step',
          element,
          binding: externalWithExtras,
        }),
      );
      expect(extractNodeBlock(xml, 'Step').split(' ')[0]).toBe(
        `<${serviceTaskLikeXmlTag(element)}`,
      );
      expect(extensionBlock(xml)).toBe(FROZEN_EXTERNAL_EXTRAS_BLOCK);
    },
  );
});

describe('irToXml: scriptTask serialization', () => {
  it('emits a bpmn:scriptTask carrying its format, the body text verbatim inside it, and re-reads clean', async () => {
    const scriptXml = await irToXml(
      around(
        scriptTask(
          'Compute',
          'javascript',
          'var total = amount * 2;\nreturn total;',
        ),
      ),
    );
    expect(extractNodeBlock(scriptXml, 'Compute')).toBe(
      '<bpmn:scriptTask id="Compute" name="Compute" scriptFormat="javascript">\n' +
        '      <bpmn:incoming>F1</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
        '      <bpmn:script>var total = amount * 2;\nreturn total;</bpmn:script>\n' +
        '    </bpmn:scriptTask>',
    );
    await expectNoModdleWarnings(scriptXml);
  });
});

describe('irToXml: documentation', () => {
  const documentedIr: BpmnProcess = {
    ...chained([
      { kind: 'startEvent', id: 'Start' },
      { kind: 'userTask', id: 'Review', documentation: 'Review the order.' },
      { kind: 'endEvent', id: 'End', documentation: 'Order handled.' },
    ]),
    documentation: 'Process notes.',
  };

  let documentedXml: string;
  let proc: Moddle;

  beforeAll(async () => {
    documentedXml = await irToXml(documentedIr);
    proc = await parseProcessTree(documentedXml);
  });

  it("writes a bpmn:documentation child carrying the exact text, before the node's other children and with no textFormat attribute, on the process and on every carrying node", () => {
    expect(documentationOf(proc)).toEqual(['Process notes.']);
    expect(documentationOf(childById(proc, 'Review'))).toEqual([
      'Review the order.',
    ]);
    expect(documentationOf(childById(proc, 'End'))).toEqual(['Order handled.']);
    expect(childById(proc, 'Start').documentation).toBeUndefined();

    expect(documentedXml.match(/<bpmn:documentation[^>]*>/g)).toEqual([
      '<bpmn:documentation>',
      '<bpmn:documentation>',
      '<bpmn:documentation>',
    ]);

    const reviewBlock = extractNodeBlock(documentedXml, 'Review');
    expect(reviewBlock.indexOf('<bpmn:documentation>')).toBeGreaterThan(-1);
    expect(reviewBlock.indexOf('<bpmn:documentation>')).toBeLessThan(
      reviewBlock.indexOf('<bpmn:incoming>'),
    );
  });
});

/** `PStart -> Outer(OStart -> Inner(IStart -> Deep -> IEnd) -> OEnd) -> PEnd`. */
const twoLevelIr: BpmnProcess = chained([
  { kind: 'startEvent', id: 'PStart' },
  chainedSub('Outer', [
    { kind: 'startEvent', id: 'OStart' },
    chainedSub('Inner', [
      { kind: 'startEvent', id: 'IStart' },
      { kind: 'userTask', id: 'Deep' },
      { kind: 'endEvent', id: 'IEnd' },
    ]),
    { kind: 'endEvent', id: 'OEnd' },
  ]),
  { kind: 'endEvent', id: 'PEnd' },
]);

describe('irToXml: sub-process containment', () => {
  const nestedIr: BpmnProcess = chained([
    { kind: 'startEvent', id: 'PStart' },
    chainedSub('sub', [
      { kind: 'startEvent', id: 'SubStart' },
      { kind: 'userTask', id: 'Review', name: 'Review', assignee: 'demo' },
      { kind: 'endEvent', id: 'SubEnd' },
    ]),
    { kind: 'endEvent', id: 'PEnd' },
  ]);

  it('emits a bpmn:SubProcess holding its own children and flows, wired to them, the parent holding neither', async () => {
    const nestedXml = await irToXml(nestedIr);
    await expectNoModdleWarnings(nestedXml);
    const proc = await parseProcessTree(nestedXml);

    const sub = childById(proc, 'sub');
    expect(sub.$type).toBe('bpmn:SubProcess');
    expect(structureOf(sub)).toEqual([
      'bpmn:StartEvent SubStart',
      'bpmn:UserTask Review',
      'bpmn:EndEvent SubEnd',
      'bpmn:SequenceFlow SF_SubStart_Review',
      'bpmn:SequenceFlow SF_Review_SubEnd',
    ]);
    expect(structureOf(proc)).toEqual([
      'bpmn:StartEvent PStart',
      'bpmn:SubProcess sub',
      'bpmn:EndEvent PEnd',
      'bpmn:SequenceFlow SF_PStart_sub',
      'bpmn:SequenceFlow SF_sub_PEnd',
    ]);

    const review = childById(sub, 'Review');
    expect((review.incoming ?? []).map((f) => f.id)).toEqual([
      'SF_SubStart_Review',
    ]);
    expect((review.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Review_SubEnd',
    ]);
    expect(childById(proc, 'SF_PStart_sub').targetRef?.id).toBe('sub');
    expect(childById(proc, 'SF_sub_PEnd').sourceRef?.id).toBe('sub');
  });

  it('wires a nested exclusive gateway default to the nested flow', async () => {
    const gatewayIr: BpmnProcess = chained([
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'sub',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          gateway('Gw', 'SF_Gw_B'),
          { kind: 'userTask', id: 'A' },
          { kind: 'userTask', id: 'B' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_SubStart_Gw', sourceRef: 'SubStart', targetRef: 'Gw' },
          edge('Gw', 'A', { id: 'SF_Gw_A', condition: '${ok}' }),
          { id: 'SF_Gw_B', sourceRef: 'Gw', targetRef: 'B' },
          { id: 'SF_A_End', sourceRef: 'A', targetRef: 'SubEnd' },
          { id: 'SF_B_End', sourceRef: 'B', targetRef: 'SubEnd' },
        ],
      },
      { kind: 'endEvent', id: 'PEnd' },
    ]);

    const tree = await parseProcessTree(await irToXml(gatewayIr));
    const sub = childById(tree, 'sub');
    const gw = childById(sub, 'Gw');
    expect(gw.$type).toBe('bpmn:ExclusiveGateway');
    expect(gw.default?.id).toBe('SF_Gw_B');
  });

  it('serializes two-level nesting recursively, each level holding its own children only', async () => {
    const tree = await parseProcessTree(await irToXml(twoLevelIr));
    const outer = childById(tree, 'Outer');
    const inner = childById(outer, 'Inner');
    expect(structureOf(tree)).toEqual([
      'bpmn:StartEvent PStart',
      'bpmn:SubProcess Outer',
      'bpmn:EndEvent PEnd',
      'bpmn:SequenceFlow SF_PStart_Outer',
      'bpmn:SequenceFlow SF_Outer_PEnd',
    ]);
    expect(structureOf(outer)).toEqual([
      'bpmn:StartEvent OStart',
      'bpmn:SubProcess Inner',
      'bpmn:EndEvent OEnd',
      'bpmn:SequenceFlow SF_OStart_Inner',
      'bpmn:SequenceFlow SF_Inner_OEnd',
    ]);
    expect(structureOf(inner)).toEqual([
      'bpmn:StartEvent IStart',
      'bpmn:UserTask Deep',
      'bpmn:EndEvent IEnd',
      'bpmn:SequenceFlow SF_IStart_Deep',
      'bpmn:SequenceFlow SF_Deep_IEnd',
    ]);
  });
});

describe('irToXml: DI expansion hint for sub-processes', () => {
  const twoChildrenIr: BpmnProcess = chained([
    { kind: 'startEvent', id: 'PStart' },
    chainedSub('sub', [
      { kind: 'startEvent', id: 'SubStart' },
      { kind: 'userTask', id: 'ReviewA', name: 'Review A' },
      { kind: 'userTask', id: 'ReviewB', name: 'Review B' },
      { kind: 'endEvent', id: 'SubEnd' },
    ]),
    { kind: 'endEvent', id: 'PEnd' },
  ]);

  it('lays every nested child strictly inside its parent, under one diagram', async () => {
    const xml = await irToXml(twoChildrenIr);
    expect(diagramCount(xml)).toBe(1);
    const shapes = await parseDiShapesById(xml);
    expectInside(shapes, 'sub', ['SubStart', 'ReviewA', 'ReviewB', 'SubEnd']);
  });

  it('two-level nesting: inner sub-process sits inside the outer, inner children inside the inner', async () => {
    const xml = await irToXml(twoLevelIr);
    const shapes = await parseDiShapesById(xml);
    expectInside(shapes, 'Outer', ['Inner']);
    expectInside(shapes, 'Inner', ['IStart', 'Deep', 'IEnd']);
  });

  it('an empty sub-process body does not throw', async () => {
    const emptySubIr: BpmnProcess = chained([
      { kind: 'startEvent', id: 'PStart' },
      chainedSub('sub', []),
      { kind: 'endEvent', id: 'PEnd' },
    ]);
    await expect(irToXml(emptySubIr)).resolves.not.toThrow();
  });
});

describe('irToXml: callActivity serialization', () => {
  /** A call activity populating every feature it has, in one node. */
  const richCallIr: BpmnProcess = {
    id: 'caller',
    name: 'Caller',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'Start' },
      {
        kind: 'callActivity',
        id: 'CallSub',
        name: 'Call sub',
        calledElement: 'sub-process',
        binding: { kind: 'deployment' },
        businessKey: '${execution.processBusinessKey}',
        inMappings: [
          { kind: 'all' },
          { kind: 'variable', source: 'amount', target: 'amount' },
          {
            kind: 'expression',
            sourceExpression: '${total * 2}',
            target: 'doubled',
            local: true,
          },
        ],
        outMappings: [
          { kind: 'variable', source: 'result', target: 'outcome' },
          {
            kind: 'expression',
            sourceExpression: '${status}',
            target: 'final',
          },
        ],
      },
      { kind: 'endEvent', id: 'End' },
    ],
    sequenceFlows: [
      { id: 'F_Start_Call', sourceRef: 'Start', targetRef: 'CallSub' },
      { id: 'F_Call_End', sourceRef: 'CallSub', targetRef: 'End' },
    ],
  };

  let callXml: string;
  let call: Moddle;

  beforeAll(async () => {
    callXml = await irToXml(richCallIr);
    const proc = await parseProcessTreeWithOperaton(callXml);
    call = childById(proc, 'CallSub');
  });

  it('emits a bpmn:CallActivity carrying its name and calledElement, re-read clean with the extension', async () => {
    expect(call.$type).toBe('bpmn:CallActivity');
    expect(call.name).toBe('Call sub');
    expect(call.calledElement).toBe('sub-process');
    await expectNoModdleWarnings(callXml);
  });

  it('emits the business key, then the in-mappings, then the out-mappings, each with its own attributes', () => {
    expect(
      (call.extensionElements?.values ?? []).map((v) => [
        v.$type,
        pick(v, [
          'businessKey',
          'variables',
          'source',
          'sourceExpression',
          'target',
          'local',
        ]),
      ]),
    ).toEqual([
      ['operaton:In', { businessKey: '${execution.processBusinessKey}' }],
      ['operaton:In', { variables: 'all' }],
      ['operaton:In', { source: 'amount', target: 'amount' }],
      [
        'operaton:In',
        { sourceExpression: '${total * 2}', target: 'doubled', local: true },
      ],
      ['operaton:Out', { source: 'result', target: 'outcome' }],
      ['operaton:Out', { sourceExpression: '${status}', target: 'final' }],
    ]);
  });

  it.each<[string, VersionBinding | undefined, Record<string, string>]>([
    [
      'a deployment binding writes calledElementBinding alone',
      { kind: 'deployment' },
      { calledElementBinding: 'deployment' },
    ],
    [
      'a version binding writes calledElementBinding and calledElementVersion',
      { kind: 'version', version: '7' },
      { calledElementBinding: 'version', calledElementVersion: '7' },
    ],
    [
      'no binding writes neither, and no extensionElements wrapper',
      undefined,
      {},
    ],
  ])('%s', async (_title, binding, expected) => {
    const ir = minimalCallIr({
      ...callActivity('CallSub', 'sub'),
      ...(binding === undefined ? {} : { binding }),
    });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    expect(
      pick(childById(proc, 'CallSub'), [
        'calledElementBinding',
        'calledElementVersion',
        'extensionElements',
      ]),
    ).toEqual(expected);
  });

  it('derives a humanized name for an unnamed call activity', async () => {
    const ir = minimalCallIr(callActivity('ProcessPayment', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    expect(childById(proc, 'ProcessPayment').name).toBe('Process Payment');
  });

  it.each([
    [
      'a class mapper writes operaton:variableMappingClass and no delegate attribute',
      { kind: 'class', className: 'com.acme.Mapper' } as const,
      { variableMappingClass: 'com.acme.Mapper' },
    ],
    [
      'a delegate mapper writes operaton:variableMappingDelegateExpression and no class attribute',
      { kind: 'delegateExpression', expression: '${mapperBean}' } as const,
      { variableMappingDelegateExpression: '${mapperBean}' },
    ],
  ])('%s', async (_title, mapper, expected) => {
    const ir = minimalCallIr({ ...callActivity('CallSub', 'sub'), mapper });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    expect(
      pick(childById(proc, 'CallSub'), [
        'variableMappingClass',
        'variableMappingDelegateExpression',
      ]),
    ).toEqual(expected);
  });
});

describe('irToXml: event layer (errors + escalations)', () => {
  /**
   * The whole error/escalation surface at once: a declared error message, an
   * interrupting error handler inside a sub-process, an `alongside` escalation
   * handler beside the main chain, and a throw and an emit of the same two
   * codes.
   */
  const eventIr: BpmnProcess = {
    ...chained(
      [
        { kind: 'startEvent', id: 'PStart' },
        chainedSub(
          'OuterSub',
          [
            { kind: 'startEvent', id: 'OSubStart' },
            { kind: 'userTask', id: 'OWork', assignee: 'demo' },
            { kind: 'endEvent', id: 'OSubEnd' },
          ],
          {
            unwired: [
              triggeredSub('ErrHandler', [
                typedEvent(
                  'startEvent',
                  'ErrStart',
                  errorDef('PF', { codeVariable: 'c', messageVariable: 'm' }),
                ),
                { kind: 'userTask', id: 'Recover' },
                { kind: 'endEvent', id: 'ErrEnd' },
              ]),
            ],
          },
        ),
        typedEvent('intermediateThrowEvent', 'Emit1', escalationDef('LS')),
        typedEvent('endEvent', 'ThrowPF', errorDef('PF')),
      ],
      {
        unwired: [
          triggeredSub('EscHandler', [
            typedEvent(
              'startEvent',
              'EscStart',
              escalationDef('LS', 'v'),
              false,
            ),
            { kind: 'userTask', id: 'Notify' },
            { kind: 'endEvent', id: 'EscEnd' },
          ]),
        ],
      },
    ),
    errorDecls: [{ name: 'PF', code: 'PF', message: 'boom' }],
  };

  let defs: Moddle;

  beforeAll(async () => {
    defs = await parseDefinitionsWithOperaton(await irToXml(eventIr));
  });

  it('synthesizes exactly one bpmn:Error root, shared by the handler and the throw', () => {
    const errors = rootsOfType(defs, 'bpmn:Error');
    expect(errors).toHaveLength(1);
    const errorRoot = errors[0]!;
    expect(errorRoot.id).toBe('Error_PF');
    expect(errorRoot.errorCode).toBe('PF');
    expect(errorRoot.errorMessage).toBe('boom');

    const handlerStart = requireDeep(defs, 'ErrStart');
    const throwEnd = requireDeep(defs, 'ThrowPF');
    expect(soleDef(handlerStart).errorRef?.id).toBe('Error_PF');
    expect(soleDef(throwEnd).errorRef?.id).toBe('Error_PF');
  });

  it('synthesizes exactly one bpmn:Escalation root, shared by the handler and the emit', () => {
    const escalations = rootsOfType(defs, 'bpmn:Escalation');
    expect(escalations).toHaveLength(1);
    const escRoot = escalations[0]!;
    expect(escRoot.id).toBe('Escalation_LS');
    expect(escRoot.escalationCode).toBe('LS');

    const handlerStart = requireDeep(defs, 'EscStart');
    const emit = requireDeep(defs, 'Emit1');
    expect(soleDef(handlerStart).escalationRef?.id).toBe('Escalation_LS');
    expect(soleDef(emit).escalationRef?.id).toBe('Escalation_LS');
  });

  it('emits a root per declaration, named by the declaration and keyed by its code, for codes nothing raises', async () => {
    const declaredIr: BpmnProcess = {
      ...minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          { kind: 'endEvent', id: 'E' },
        ],
        [{ id: 'SF_S_E', sourceRef: 'S', targetRef: 'E' }],
      ),
      errorDecls: [
        { name: 'OrderFailed', code: 'order.failed', message: 'gone' },
      ],
      escalationDecls: [{ name: 'ManualReview', code: 'MANUAL_REVIEW' }],
    };
    const d = await parseDefinitionsWithOperaton(await irToXml(declaredIr));

    expect(
      rootsOfType(d, 'bpmn:Error').map((r) => ({
        id: r.id,
        name: r.name,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
      })),
    ).toEqual([
      {
        id: 'Error_order.failed',
        name: 'OrderFailed',
        errorCode: 'order.failed',
        errorMessage: 'gone',
      },
    ]);
    expect(
      rootsOfType(d, 'bpmn:Escalation').map((r) => ({
        id: r.id,
        name: r.name,
        escalationCode: r.escalationCode,
      })),
    ).toEqual([
      {
        id: 'Escalation_MANUAL_REVIEW',
        name: 'ManualReview',
        escalationCode: 'MANUAL_REVIEW',
      },
    ]);
  });

  it('flags the error handler triggeredByEvent and stamps the catch bindings on its start', () => {
    const handler = requireDeep(defs, 'ErrHandler');
    expect(handler.$type).toBe('bpmn:SubProcess');
    expect(handler.triggeredByEvent).toBe(true);

    const def = soleDef(requireDeep(defs, 'ErrStart'));
    expect(def.$type).toBe('bpmn:ErrorEventDefinition');
    expect(def.errorCodeVariable).toBe('c');
    expect(def.errorMessageVariable).toBe('m');
  });

  it('marks the alongside escalation handler start non-interrupting with its code binding', () => {
    const start = requireDeep(defs, 'EscStart');
    expect(start.isInterrupting).toBe(false);
    const def = soleDef(start);
    expect(def.$type).toBe('bpmn:EscalationEventDefinition');
    expect(def.escalationCodeVariable).toBe('v');
  });

  it('catch-all handler emits no errorRef and no root when the code is unused elsewhere', async () => {
    const catchAllIr: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        triggeredSub('AnyErr', [
          typedEvent('startEvent', 'AnyStart', errorDef()),
          { kind: 'userTask', id: 'Log' },
          { kind: 'endEvent', id: 'AnyEnd' },
        ]),
      ],
      [{ id: 'SF_S_E', sourceRef: 'S', targetRef: 'E' }],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(catchAllIr));
    expect(rootsOfType(d, 'bpmn:Error')).toHaveLength(0);
    expect(soleDef(requireDeep(d, 'AnyStart')).errorRef).toBeUndefined();
  });

  it('lays event sub-processes out with children strictly inside their handler box', async () => {
    const xml = await irToXml(eventIr);
    expect(diagramCount(xml)).toBe(1);
    const shapes = await parseDiShapesById(xml);

    expectInside(shapes, 'EscHandler', ['EscStart', 'Notify', 'EscEnd']);
    expectInside(shapes, 'OuterSub', ['ErrHandler']);
    expectInside(shapes, 'ErrHandler', ['ErrStart', 'Recover', 'ErrEnd']);
  });
});

describe('irToXml: synthesized root ids', () => {
  it.each<
    [
      string,
      EndEventDefinition,
      string,
      string | undefined,
      Record<string, string>,
    ]
  >([
    [
      'an error code with non-id characters is sanitized into the id and kept verbatim as the code',
      errorDef('NEEDS REVIEW!'),
      'bpmn:Error',
      undefined,
      {
        id: 'Error_NEEDS_REVIEW_',
        name: 'NEEDS REVIEW!',
        errorCode: 'NEEDS REVIEW!',
      },
    ],
    [
      'an error root id a task already holds is suffixed',
      errorDef('Boom'),
      'bpmn:Error',
      'Error_Boom',
      { id: 'Error_Boom_2', name: 'Boom', errorCode: 'Boom' },
    ],
    [
      'a signal root id a task already holds is suffixed',
      signalDef('Ping'),
      'bpmn:Signal',
      'Signal_Ping',
      { id: 'Signal_Ping_2', name: 'Ping' },
    ],
    [
      'a message name with non-id characters is sanitized into the id and kept verbatim as the name',
      messageDef('Order received!'),
      'bpmn:Message',
      undefined,
      { id: 'Message_Order_received_', name: 'Order received!' },
    ],
  ])('%s', async (_title, def, type, occupied, expected) => {
    const occupant: FlowElement[] =
      occupied === undefined ? [] : [{ kind: 'userTask', id: occupied }];
    const ir = chained([
      { kind: 'startEvent', id: 'S' },
      ...occupant,
      typedEvent('endEvent', 'T', def),
    ]);
    expect(
      rootsOfType(await defsOf(ir), type).map((r) =>
        pick(r, ['id', 'name', 'errorCode']),
      ),
    ).toEqual([expected]);
  });
});

describe('irToXml: event layer (message + signal + timer + conditional)', () => {
  /** A message handler, an alongside signal handler, and both signal throws. */
  const signalIr: BpmnProcess = processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      eventHandler('MsgHandler', 'MsgStart', messageDef('PaymentReceived')),
      eventHandler('SigHandler', 'SigStart', signalDef('Cancelled'), false),
      typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
      typedEvent('endEvent', 'ThrowSig', signalDef('Cancelled')),
    ],
    [
      { id: 'SF_PStart_EmitSig', sourceRef: 'PStart', targetRef: 'EmitSig' },
      edge('EmitSig', 'ThrowSig', { id: 'SF_EmitSig_ThrowSig' }),
    ],
  );

  let defs: Moddle;

  beforeAll(async () => {
    defs = await parseDefinitionsWithOperaton(await irToXml(signalIr));
  });

  it('synthesizes exactly one bpmn:Message root referenced by the handler start', () => {
    const messages = rootsOfType(defs, 'bpmn:Message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('Message_PaymentReceived');
    expect(messages[0]!.name).toBe('PaymentReceived');

    const def = soleDef(requireDeep(defs, 'MsgStart'));
    expect(def.$type).toBe('bpmn:MessageEventDefinition');
    expect(def.messageRef?.id).toBe('Message_PaymentReceived');
  });

  // The engine reads a thrown message's implementation off the definition and
  // ignores the same attribute on the event, so the whole event block is
  // frozen: the binding on the definition and nothing `operaton:` on the tag.
  it.each<
    [string, 'endEvent' | 'intermediateThrowEvent', ServiceTaskBinding, string]
  >([
    [
      'a class binding on a thrown message',
      'endEvent',
      classBinding('com.example.Send'),
      'operaton:class="com.example.Send"',
    ],
    [
      'an external binding on a thrown message',
      'endEvent',
      externalBinding('send-ack'),
      'operaton:type="external" operaton:topic="send-ack"',
    ],
    [
      'a delegate binding on an emitted message',
      'intermediateThrowEvent',
      delegateBinding('${senderBean}'),
      'operaton:delegateExpression="${senderBean}"',
    ],
  ])(
    'writes %s onto the message definition',
    async (_title, kind, binding, attribute) => {
      const xml = await irToXml(
        around({ ...typedEvent(kind, 'Sent', messageDef('Ack')), binding }),
      );
      expect(extractNodeBlock(xml, 'Sent')).toBe(
        `<bpmn:${kind} id="Sent">\n` +
          '      <bpmn:incoming>F1</bpmn:incoming>\n' +
          '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
          `      <bpmn:messageEventDefinition messageRef="Message_Ack" ${attribute} />\n` +
          `    </bpmn:${kind}>`,
      );
    },
  );

  it('synthesizes one bpmn:Signal root shared by the handler, the emit, and the throw', () => {
    const signals = rootsOfType(defs, 'bpmn:Signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('Signal_Cancelled');
    expect(signals[0]!.name).toBe('Cancelled');

    const handlerStart = soleDef(requireDeep(defs, 'SigStart'));
    const emit = soleDef(requireDeep(defs, 'EmitSig'));
    const throwEnd = soleDef(requireDeep(defs, 'ThrowSig'));
    expect(handlerStart.$type).toBe('bpmn:SignalEventDefinition');
    expect(emit.$type).toBe('bpmn:SignalEventDefinition');
    expect(throwEnd.$type).toBe('bpmn:SignalEventDefinition');
    expect(handlerStart.signalRef?.id).toBe('Signal_Cancelled');
    expect(emit.signalRef?.id).toBe('Signal_Cancelled');
    expect(throwEnd.signalRef?.id).toBe('Signal_Cancelled');
    expect(requireDeep(defs, 'SigStart').isInterrupting).toBe(false);
  });

  it('lays the message and signal handler bodies out inside their handler boxes', async () => {
    const xml = await irToXml(signalIr);
    expect(diagramCount(xml)).toBe(1);
    const shapes = await parseDiShapesById(xml);
    expectInside(shapes, 'MsgHandler', [
      'MsgStart',
      'MsgHandler_Work',
      'MsgHandler_End',
    ]);
    expectInside(shapes, 'SigHandler', [
      'SigStart',
      'SigHandler_Work',
      'SigHandler_End',
    ]);
  });

  it('orders mixed roots [process, ...errors, ...escalations, ...messages, ...signals]', async () => {
    const mixedIr: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateThrowEvent', 'EmitEsc', escalationDef('LS')),
        typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
        typedEvent('endEvent', 'ThrowErr', errorDef('PF')),
        eventHandler('MsgHandler', 'MsgStart', messageDef('OrderReceived')),
      ],
      [
        { id: 'SF_S_EmitEsc', sourceRef: 'S', targetRef: 'EmitEsc' },
        edge('EmitEsc', 'EmitSig', { id: 'SF_EmitEsc_EmitSig' }),
        edge('EmitSig', 'ThrowErr', { id: 'SF_EmitSig_ThrowErr' }),
      ],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(mixedIr));
    expect(d.rootElements.map((r) => r.$type)).toEqual([
      'bpmn:Process',
      'bpmn:Error',
      'bpmn:Escalation',
      'bpmn:Message',
      'bpmn:Signal',
    ]);
  });
});

describe('irToXml: event layer (compensation)', () => {
  /**
   * A compensation handler inside a sub-process, plus a compensation emit and
   * throw in the parent. Compensation is payload-less, so unlike the
   * error/escalation fixture there is no identity to share a root over.
   */
  const compensationIr: BpmnProcess = processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      chainedSub(
        'OuterSub',
        [
          { kind: 'startEvent', id: 'OSubStart' },
          { kind: 'userTask', id: 'OWork', assignee: 'demo' },
          { kind: 'endEvent', id: 'OSubEnd' },
        ],
        {
          unwired: [
            eventHandler('CompHandler', 'CompStart', { kind: 'compensation' }),
          ],
        },
      ),
      typedEvent('intermediateThrowEvent', 'EmitComp', {
        kind: 'compensation',
      }),
      typedEvent('endEvent', 'ThrowComp', { kind: 'compensation' }),
    ],
    [
      { id: 'SF_PStart_OuterSub', sourceRef: 'PStart', targetRef: 'OuterSub' },
      edge('OuterSub', 'EmitComp', { id: 'SF_OuterSub_EmitComp' }),
      edge('EmitComp', 'ThrowComp', { id: 'SF_EmitComp_ThrowComp' }),
    ],
  );

  let defs: Moddle;
  let xml: string;

  beforeAll(async () => {
    xml = await irToXml(compensationIr);
    defs = await parseDefinitionsWithOperaton(xml);
  });

  it('emits a bare CompensateEventDefinition on the handler start, the emit and the throw, and no root', () => {
    expect(extractNodeBlock(xml, 'CompStart')).toBe(
      '<bpmn:startEvent id="CompStart">\n' +
        '          <bpmn:outgoing>SF_CompStart_CompHandler_Work</bpmn:outgoing>\n' +
        '          <bpmn:compensateEventDefinition />\n' +
        '        </bpmn:startEvent>',
    );
    expect(soleDef(requireDeep(defs, 'EmitComp')).$type).toBe(
      'bpmn:CompensateEventDefinition',
    );
    expect(soleDef(requireDeep(defs, 'ThrowComp')).$type).toBe(
      'bpmn:CompensateEventDefinition',
    );
    expect(defs.rootElements.map((r) => r.$type)).toEqual(['bpmn:Process']);
  });

  it('lays the compensation handler out inside its host sub-process, children inside the handler', async () => {
    expect(diagramCount(xml)).toBe(1);
    const shapes = await parseDiShapesById(xml);

    expectInside(shapes, 'OuterSub', ['CompHandler']);
    expectInside(shapes, 'CompHandler', [
      'CompStart',
      'CompHandler_Work',
      'CompHandler_End',
    ]);
  });
});

/**
 * `PStart -> Host -> PEnd`, with a boundary event on `Host` running to its own
 * end: the shape a hosted handler with an empty body lowers to.
 */
function hostedBoundaryIr(
  eventDefinition: EventDefinition,
  cancelActivity?: false,
): BpmnProcess {
  return processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Host' },
      { kind: 'endEvent', id: 'PEnd' },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Host_x',
        attachedToRef: 'Host',
        eventDefinition,
        ...(cancelActivity === false ? { cancelActivity } : {}),
      },
      { kind: 'endEvent', id: 'BoundaryEnd' },
    ],
    [
      { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
      { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
      edge('Boundary_Host_x', 'BoundaryEnd', { id: 'SF_Boundary_BoundaryEnd' }),
    ],
  );
}

describe('irToXml: boundary events', () => {
  it.each<[string, false | undefined, string]>([
    [
      'an interrupting boundary writes no cancelActivity',
      undefined,
      '<bpmn:boundaryEvent id="Boundary_Host_x" attachedToRef="Host">',
    ],
    [
      'a non-interrupting (alongside) boundary writes cancelActivity="false"',
      false,
      '<bpmn:boundaryEvent id="Boundary_Host_x" cancelActivity="false" attachedToRef="Host">',
    ],
  ])(
    '%s, attached to its host, with no name, no incoming and its definition',
    async (_title, cancelActivity, openingTag) => {
      const xml = await irToXml(
        hostedBoundaryIr(messageDef('Ping'), cancelActivity),
      );
      expect(extractNodeBlock(xml, 'Boundary_Host_x')).toBe(
        `${openingTag}\n` +
          '      <bpmn:outgoing>SF_Boundary_BoundaryEnd</bpmn:outgoing>\n' +
          '      <bpmn:messageEventDefinition messageRef="Message_Ping" />\n' +
          '    </bpmn:boundaryEvent>',
      );
    },
  );

  it('serializes two boundary events attached to one host', async () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Host' },
        { kind: 'endEvent', id: 'PEnd' },
        boundaryEvent('Boundary_Host_error', 'Host', errorDef('PF')),
        { kind: 'endEvent', id: 'ErrEnd' },
        boundaryEvent(
          'Boundary_Host_timer',
          'Host',
          timerDef('duration', 'PT1H'),
        ),
        { kind: 'endEvent', id: 'TimerEnd' },
      ],
      [
        { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
        { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
        edge('Boundary_Host_error', 'ErrEnd', { id: 'SF_ErrB_ErrEnd' }),
        edge('Boundary_Host_timer', 'TimerEnd', { id: 'SF_TimerB_TimerEnd' }),
      ],
    );
    const defs = await defsOf(ir);
    for (const id of ['Boundary_Host_error', 'Boundary_Host_timer']) {
      const boundary = requireDeep(defs, id);
      expect(boundary.$type).toBe('bpmn:BoundaryEvent');
      expect(boundary.attachedToRef?.id).toBe('Host');
    }
  });

  // The second host exists one container down, which is why the message names
  // the container rule rather than an unknown id.
  it.each([
    ['is nowhere in the document', ghostHostIr(), 'Ghost'],
    ['sits inside a sub-process', hostInSubProcessIr(), 'Host'],
  ])('refuses a boundary event whose host %s', async (_title, ir, host) => {
    await expect(irToXml(ir)).rejects.toThrow(
      `BoundaryEvent "Boundary_Host_x" is attached to "${host}", which is not a flow element of this container.`,
    );
  });
});

/** {@link hostedBoundaryIr} with the attachment pointing at an absent node. */
function ghostHostIr(): BpmnProcess {
  const ir = hostedBoundaryIr(messageDef('Ping'));
  return {
    ...ir,
    flowElements: ir.flowElements.map((el) =>
      el.kind === 'boundaryEvent' ? { ...el, attachedToRef: 'Ghost' } : el,
    ),
  };
}

/** A boundary event whose host is a real node, but one container deeper. */
function hostInSubProcessIr(): BpmnProcess {
  return processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      chainedSub('Sub', [{ kind: 'userTask', id: 'Host' }]),
      { kind: 'endEvent', id: 'PEnd' },
      boundaryEvent('Boundary_Host_x', 'Host', messageDef('Ping')),
    ],
    [
      { id: 'SF_PStart_Sub', sourceRef: 'PStart', targetRef: 'Sub' },
      { id: 'SF_Sub_PEnd', sourceRef: 'Sub', targetRef: 'PEnd' },
    ],
  );
}

/** `PStart -> Catch -> PEnd`, the shape the desugarer produces for `await`. */
function mainFlowCatchIr(
  eventDefinition: CatchEventDefinition,
  id = 'Catch_x',
): BpmnProcess {
  return processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'intermediateCatchEvent', id, eventDefinition },
      { kind: 'endEvent', id: 'PEnd' },
    ],
    [
      { id: 'SF_PStart_Catch', sourceRef: 'PStart', targetRef: id },
      { id: 'SF_Catch_PEnd', sourceRef: id, targetRef: 'PEnd' },
    ],
  );
}

describe('irToXml: intermediate catch events', () => {
  it('emits a nameless bpmn:IntermediateCatchEvent wired with incoming and outgoing, its MessageEventDefinition referencing a derived Message root', async () => {
    const xml = await irToXml(mainFlowCatchIr(messageDef('Invoice Received')));
    expect(extractNodeBlock(xml, 'Catch_x')).toBe(
      '<bpmn:intermediateCatchEvent id="Catch_x">\n' +
        '      <bpmn:incoming>SF_PStart_Catch</bpmn:incoming>\n' +
        '      <bpmn:outgoing>SF_Catch_PEnd</bpmn:outgoing>\n' +
        '      <bpmn:messageEventDefinition messageRef="Message_Invoice_Received" />\n' +
        '    </bpmn:intermediateCatchEvent>',
    );
    const defs = await parseDefinitionsWithOperaton(xml);
    expect(
      rootsOfType(defs, 'bpmn:Message').map((r) => pick(r, ['id', 'name'])),
    ).toEqual([{ id: 'Message_Invoice_Received', name: 'Invoice Received' }]);
  });

  it.each<
    ['timeDuration' | 'timeDate' | 'timeCycle', CatchEventDefinition, string]
  >([
    ['timeDuration', timerDef('duration', 'PT1H'), 'PT1H'],
    ['timeDate', timerDef('date', '${dueDate}'), '${dueDate}'],
    ['timeCycle', timerDef('cycle', 'R/PT10M'), 'R/PT10M'],
  ])(
    'emits a TimerEventDefinition carrying its %s child and no other',
    async (child, eventDefinition, body) => {
      const defs = await defsOf(mainFlowCatchIr(eventDefinition));
      const def = soleDef(requireDeep(defs, 'Catch_x'));
      expect(def.$type).toBe('bpmn:TimerEventDefinition');
      expect({
        timeDuration: def.timeDuration?.body,
        timeDate: def.timeDate?.body,
        timeCycle: def.timeCycle?.body,
      }).toEqual({
        timeDuration: undefined,
        timeDate: undefined,
        timeCycle: undefined,
        [child]: body,
      });
    },
  );

  it('emits a SignalEventDefinition referencing a derived Signal root', async () => {
    const defs = await defsOf(mainFlowCatchIr(signalDef('Ready')));
    const def = soleDef(requireDeep(defs, 'Catch_x'));
    expect(def.$type).toBe('bpmn:SignalEventDefinition');

    const signals = rootsOfType(defs, 'bpmn:Signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('Signal_Ready');
    expect(signals[0]!.name).toBe('Ready');
    expect(def.signalRef?.id).toBe(signals[0]!.id);
  });

  it('emits a ConditionalEventDefinition whose condition body is the raw expression', async () => {
    const defs = await defsOf(mainFlowCatchIr(conditionDef('${amount > 100}')));
    const def = soleDef(requireDeep(defs, 'Catch_x'));
    expect(def.$type).toBe('bpmn:ConditionalEventDefinition');
    expect(def.condition?.body).toBe('${amount > 100}');
  });
});

describe('irToXml: link events', () => {
  it('emits a link pair as two named events sharing one link name, nothing leaving the throw, nothing entering the catch, both laid out', async () => {
    const link: Extract<EventDefinition, { kind: 'link' }> = {
      kind: 'link',
      linkName: 'Retry',
    };
    const ir = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Work' },
        {
          kind: 'intermediateThrowEvent',
          id: 'ToRetry',
          eventDefinition: link,
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'AtRetry',
          eventDefinition: link,
        },
        { kind: 'userTask', id: 'Fix' },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      [
        { id: 'SF_PStart_Work', sourceRef: 'PStart', targetRef: 'Work' },
        { id: 'SF_Work_ToRetry', sourceRef: 'Work', targetRef: 'ToRetry' },
        { id: 'SF_AtRetry_Fix', sourceRef: 'AtRetry', targetRef: 'Fix' },
        { id: 'SF_Fix_PEnd', sourceRef: 'Fix', targetRef: 'PEnd' },
      ],
    );
    const xml = await irToXml(ir);
    const defs = await parseDefinitionsWithOperaton(xml);

    const throwNode = requireDeep(defs, 'ToRetry');
    const catchNode = requireDeep(defs, 'AtRetry');
    const throwDef = soleDef(throwNode);
    const catchDef = soleDef(catchNode);

    expect({
      throwType: throwNode.$type,
      throwDefType: throwDef.$type,
      throwDefName: throwDef.name,
      throwName: throwNode.name,
      throwOutgoing: (throwNode.outgoing ?? []).map((f) => f.id),
      catchType: catchNode.$type,
      catchDefType: catchDef.$type,
      catchDefName: catchDef.name,
      catchName: catchNode.name,
      catchIncoming: (catchNode.incoming ?? []).map((f) => f.id),
      rootTypes: defs.rootElements.map((r) => r.$type),
      hasThrowShape: xml.includes('bpmnElement="ToRetry"'),
      hasCatchShape: xml.includes('bpmnElement="AtRetry"'),
    }).toEqual({
      throwType: 'bpmn:IntermediateThrowEvent',
      throwDefType: 'bpmn:LinkEventDefinition',
      throwDefName: 'Retry',
      throwName: 'Retry',
      throwOutgoing: [],
      catchType: 'bpmn:IntermediateCatchEvent',
      catchDefType: 'bpmn:LinkEventDefinition',
      catchDefName: 'Retry',
      catchName: 'Retry',
      catchIncoming: [],
      rootTypes: ['bpmn:Process'],
      hasThrowShape: true,
      hasCatchShape: true,
    });
  });
});

/** One flow node of the process, Operaton settings resolved as typed properties. */
async function engineNode(xmlStr: string, id: string): Promise<Moddle> {
  const proc = await parseProcessTreeWithOperaton(xmlStr);
  return childById(proc, id);
}

/** The flat engine settings spread over five node kinds, one carrying none. */
const engineSettingsIr: BpmnProcess = {
  id: 'engine-settings',
  isExecutable: true,
  versionTag: '1.4.2',
  historyTimeToLive: 'P90D',
  candidateStarterUsers: 'demo,manager',
  candidateStarterGroups: 'adjusters',
  flowElements: [
    {
      kind: 'startEvent',
      id: 'Start',
      asyncAfter: true,
      jobPriority: '50',
      initiator: 'claimant',
    },
    {
      kind: 'userTask',
      id: 'Review',
      assignee: 'demo',
      formKey: 'embedded:app:forms/review.html',
      candidateUsers: 'ann,bob',
      candidateGroups: 'reviewers',
      dueDate: '${dateTime().plusDays(2)}',
      followUpDate: '2026-01-31T12:00:00',
      priority: '75',
      asyncBefore: true,
      exclusive: false,
      formFields: [{ id: 'amount', type: 'number', label: 'Amount' }],
      retryCycle: 'R3/PT5M',
    },
    {
      kind: 'serviceTask',
      id: 'Auto',
      binding: exprBinding('${auto.run(execution)}'),
      resultVariable: 'outcome',
    },
    {
      kind: 'scriptTask',
      id: 'Calc',
      format: 'javascript',
      code: 'total = 1;',
      resultVariable: 'total',
      retryCycle: 'R3/PT10M',
    },
    { kind: 'endEvent', id: 'End' },
  ],
  sequenceFlows: flowChain('Start', 'Review', 'Auto', 'Calc', 'End'),
};

describe('irToXml: flat engine attributes', () => {
  let engineXml: string;
  let engineProc: Moddle;

  beforeAll(async () => {
    engineXml = await irToXml(engineSettingsIr);
    engineProc = await parseProcessTreeWithOperaton(engineXml);
  });

  it('writes the whole set of Operaton attributes the process IR carries, and nothing else', () => {
    expect({
      versionTag: engineProc.versionTag,
      historyTimeToLive: engineProc.historyTimeToLive,
      candidateStarterUsers: engineProc.candidateStarterUsers,
      candidateStarterGroups: engineProc.candidateStarterGroups,
    }).toEqual({
      versionTag: '1.4.2',
      historyTimeToLive: 'P90D',
      candidateStarterUsers: 'demo,manager',
      candidateStarterGroups: 'adjusters',
    });
    // The projection above covers every Operaton property the descriptor
    // declares on a process, so an empty `$attrs` closes the undeclared case.
    expect(engineProc.$attrs).toEqual({});
  });

  it('a process authoring no historyTimeToLive still writes the exported default', async () => {
    const xml = await irToXml({
      id: 'no-history',
      isExecutable: true,
      flowElements: [{ kind: 'startEvent', id: 'S' }],
      sequenceFlows: [],
    });
    const proc = await parseProcessTreeWithOperaton(xml);
    expect(proc.historyTimeToLive).toBe(HISTORY_TIME_TO_LIVE);
  });

  it("writes each node's settings as its own operaton: attributes and extension children, the retry cycle as a child, and nothing on a node carrying none", () => {
    const blocks = Object.fromEntries(
      ['Start', 'Review', 'Auto', 'Calc', 'End'].map((id) => [
        id,
        extractNodeBlock(engineXml, id),
      ]),
    );
    expect(blocks).toEqual({
      Start:
        '<bpmn:startEvent id="Start" operaton:asyncAfter="true" operaton:jobPriority="50" operaton:initiator="claimant">\n' +
        '      <bpmn:outgoing>F1</bpmn:outgoing>\n' +
        '    </bpmn:startEvent>',
      Review:
        '<bpmn:userTask id="Review" name="Review" operaton:asyncBefore="true" operaton:exclusive="false" operaton:assignee="demo" operaton:candidateUsers="ann,bob" operaton:candidateGroups="reviewers" operaton:dueDate="${dateTime().plusDays(2)}" operaton:followUpDate="2026-01-31T12:00:00" operaton:priority="75" operaton:formKey="embedded:app:forms/review.html">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:formData>\n' +
        '          <operaton:formField id="amount" label="Amount" type="long" />\n' +
        '        </operaton:formData>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT5M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>\n' +
        '      <bpmn:incoming>F1</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
        '    </bpmn:userTask>',
      Auto:
        '<bpmn:serviceTask id="Auto" name="Auto" operaton:expression="${auto.run(execution)}" operaton:resultVariable="outcome">\n' +
        '      <bpmn:incoming>F2</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F3</bpmn:outgoing>\n' +
        '    </bpmn:serviceTask>',
      Calc:
        '<bpmn:scriptTask id="Calc" name="Calc" scriptFormat="javascript" operaton:resultVariable="total">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT10M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>\n' +
        '      <bpmn:incoming>F3</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F4</bpmn:outgoing>\n' +
        '      <bpmn:script>total = 1;</bpmn:script>\n' +
        '    </bpmn:scriptTask>',
      End:
        '<bpmn:endEvent id="End">\n' +
        '      <bpmn:incoming>F4</bpmn:incoming>\n' +
        '    </bpmn:endEvent>',
    });
  });

  it('carries the settings on the structural kinds too: a sub-process and a boundary event', async () => {
    const nestedXml = await irToXml({
      id: 'nested',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          ...chainedSub('Sub', [
            { kind: 'startEvent', id: 'SubStart' },
            { kind: 'endEvent', id: 'SubEnd' },
          ]),
          asyncBefore: true,
          retryCycle: 'R2/PT30S',
        },
        { kind: 'endEvent', id: 'PEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Sub_timer',
          attachedToRef: 'Sub',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'duration',
            expression: 'PT1H',
          },
          asyncAfter: true,
        },
        { kind: 'endEvent', id: 'BoundaryEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Sub', sourceRef: 'PStart', targetRef: 'Sub' },
        { id: 'SF_Sub_PEnd', sourceRef: 'Sub', targetRef: 'PEnd' },
        edge('Boundary_Sub_timer', 'BoundaryEnd', {
          id: 'SF_Boundary_BoundaryEnd',
        }),
      ],
    });
    expect(extractNodeBlock(nestedXml, 'Sub')).toBe(
      '<bpmn:subProcess id="Sub" name="Sub" operaton:asyncBefore="true">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:failedJobRetryTimeCycle>R2/PT30S</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>\n' +
        '      <bpmn:incoming>SF_PStart_Sub</bpmn:incoming>\n' +
        '      <bpmn:outgoing>SF_Sub_PEnd</bpmn:outgoing>\n' +
        '      <bpmn:startEvent id="SubStart">\n' +
        '        <bpmn:outgoing>SF_SubStart_SubEnd</bpmn:outgoing>\n' +
        '      </bpmn:startEvent>\n' +
        '      <bpmn:endEvent id="SubEnd">\n' +
        '        <bpmn:incoming>SF_SubStart_SubEnd</bpmn:incoming>\n' +
        '      </bpmn:endEvent>\n' +
        '      <bpmn:sequenceFlow id="SF_SubStart_SubEnd" sourceRef="SubStart" targetRef="SubEnd" />\n' +
        '    </bpmn:subProcess>',
    );
    expect(extractNodeBlock(nestedXml, 'Boundary_Sub_timer')).toBe(
      '<bpmn:boundaryEvent id="Boundary_Sub_timer" attachedToRef="Sub" operaton:asyncAfter="true">\n' +
        '      <bpmn:outgoing>SF_Boundary_BoundaryEnd</bpmn:outgoing>\n' +
        '      <bpmn:timerEventDefinition>\n' +
        '        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>\n' +
        '      </bpmn:timerEventDefinition>\n' +
        '    </bpmn:boundaryEvent>',
    );
  });

  it.each<[string, Gateway['kind'], string]>([
    ['an exclusive gateway', 'exclusiveGateway', 'bpmn:exclusiveGateway'],
    ['a parallel gateway', 'parallelGateway', 'bpmn:parallelGateway'],
    ['an inclusive gateway', 'inclusiveGateway', 'bpmn:inclusiveGateway'],
    ['an event-based gateway', 'eventBasedGateway', 'bpmn:eventBasedGateway'],
  ])(
    '%s serializes its job settings like an activity, and none of its listeners',
    async (_title, kind, tag) => {
      const withSettings: Gateway = {
        kind,
        id: 'G',
        asyncBefore: true,
        asyncAfter: true,
        exclusive: false,
        jobPriority: '30',
        retryCycle: 'R3/PT1M',
      } as Gateway;
      const settingsXml = await irToXml(around(withSettings));
      expect(extractNodeBlock(settingsXml, 'G')).toBe(
        `<${tag} id="G" operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false" operaton:jobPriority="30">\n` +
          `      <bpmn:extensionElements>\n` +
          `        <operaton:failedJobRetryTimeCycle>R3/PT1M</operaton:failedJobRetryTimeCycle>\n` +
          `      </bpmn:extensionElements>\n` +
          `      <bpmn:incoming>F1</bpmn:incoming>\n` +
          `      <bpmn:outgoing>F2</bpmn:outgoing>\n` +
          `    </${tag}>`,
      );

      const bareXml = await irToXml(around({ kind, id: 'G' } as Gateway));
      const bareBlock = extractNodeBlock(bareXml, 'G');
      expect(bareBlock).not.toContain('operaton:');
      expect(bareBlock).not.toContain('extensionElements');

      // The type forbids a listener on a gateway (no carrier to author one
      // against, ADR 0010), so the cast supplies the shape to see the guard.
      const listenersXml = await irToXml(
        around({
          kind,
          id: 'G',
          executionListeners: [
            { event: 'start', binding: { kind: 'class', className: 'x.L' } },
          ],
        } as unknown as Gateway),
      );
      const listenerBlock = extractNodeBlock(listenersXml, 'G');
      expect(listenerBlock).not.toContain('operaton:');
      expect(listenerBlock).not.toContain('extensionElements');
    },
  );
});

/**
 * One user task carrying every nested group at once, so the assembler's
 * emission order is observable on a single wrapper: a form, all four input
 * value forms (nested two deep), an output parameter, both listener kinds
 * including a `timeout` one, and a retry cycle.
 */
const nestedGroupsIr: BpmnProcess = {
  id: 'nested-groups',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'Start' },
    {
      kind: 'userTask',
      id: 'Review',
      formFields: [{ id: 'amount', type: 'number' }],
      inputParameters: [
        { name: 'plain', value: { kind: 'text', text: 'hello' } },
        {
          name: 'scripted',
          value: { kind: 'script', format: 'groovy', code: 'a + b' },
        },
        {
          name: 'nested',
          value: {
            kind: 'list',
            items: [
              { kind: 'text', text: 'first' },
              {
                kind: 'map',
                entries: [
                  { key: 'inner', value: { kind: 'text', text: 'x' } },
                  {
                    key: 'deeper',
                    value: {
                      kind: 'list',
                      items: [{ kind: 'text', text: 'z' }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      outputParameters: [
        {
          name: 'result',
          value: {
            kind: 'map',
            entries: [{ key: 'code', value: { kind: 'text', text: '200' } }],
          },
        },
      ],
      executionListeners: [
        {
          event: 'start',
          binding: { kind: 'class', className: 'com.example.Enter' },
        },
        {
          event: 'end',
          binding: { kind: 'script', format: 'javascript', code: 'log(1);' },
        },
      ],
      taskListeners: [
        {
          event: 'create',
          binding: { kind: 'expression', expression: '${audit.log()}' },
        },
        {
          event: 'timeout',
          binding: { kind: 'delegateExpression', expression: '${escalate}' },
          timer: { kind: 'timer', timerKind: 'duration', expression: 'PT2H' },
        },
      ],
      retryCycle: 'R3/PT5M',
    },
    { kind: 'endEvent', id: 'End' },
  ],
  sequenceFlows: [
    { id: 'F1', sourceRef: 'Start', targetRef: 'Review' },
    { id: 'F2', sourceRef: 'Review', targetRef: 'End' },
  ],
};

let nestedGroupsXml: string;
/** The one extension block of {@link nestedGroupsIr}, as raw serialized text. */
let nestedGroupsBlock: string;

beforeAll(async () => {
  nestedGroupsXml = await irToXml(nestedGroupsIr);
  nestedGroupsBlock = extensionBlock(nestedGroupsXml);
});

describe("irToXml: a timer job's lock is written where BpmnParse.parseTimer reads it", () => {
  /** `S -> Host -> E` with one timer carrier of the given kind beside it. */
  const withTimerCarrier = (carrier: FlowElement): BpmnProcess =>
    processIr(
      'p',
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Host' },
        { kind: 'endEvent', id: 'E' },
        carrier,
        { kind: 'endEvent', id: 'Escaped' },
      ],
      [
        edge('S', 'Host'),
        edge('Host', 'E'),
        edge(carrier.id, 'Escaped', { id: 'SF_escape' }),
      ],
    );

  const timer = timerDef('duration', 'PT1H');

  it.each<[string, FlowElement, number]>([
    [
      'a non-exclusive boundary timer writes it on the definition and the tag',
      {
        ...boundaryEvent('Boundary_Host_timer', 'Host', timer),
        exclusive: false,
      },
      2,
    ],
    [
      'a boundary timer with no lock written writes it nowhere',
      boundaryEvent('Boundary_Host_timer', 'Host', timer),
      0,
    ],
    [
      'a non-exclusive await writes it on the definition and the tag',
      {
        ...typedEvent('intermediateCatchEvent', 'Wait', timer),
        exclusive: false,
      },
      2,
    ],
  ])('%s', async (_title, carrier, occurrences) => {
    const xml = await irToXml(withTimerCarrier(carrier));
    const block = extractNodeBlock(xml, carrier.id);
    expect(block.match(/operaton:exclusive="false"/g) ?? []).toHaveLength(
      occurrences,
    );
    expect(
      block.includes('<bpmn:timerEventDefinition operaton:exclusive="false">'),
    ).toBe(occurrences > 0);
  });
});

describe('irToXml: input/output parameters', () => {
  it('emits one operaton:inputOutput holding every value form, in IR order', () => {
    expect(nestedGroupsBlock).toMatch(
      /<operaton:inputOutput>[\s\S]*<operaton:inputParameter[\s\S]*<operaton:outputParameter[\s\S]*<\/operaton:inputOutput>/,
    );
    expect(nestedGroupsBlock.match(/<operaton:inputOutput\b/g)).toHaveLength(1);
    expect(
      [
        ...nestedGroupsBlock.matchAll(
          /<operaton:(?:in|out)putParameter name="([^"]+)"/g,
        ),
      ].map((m) => m[1]),
    ).toEqual(['plain', 'scripted', 'nested', 'result']);

    expect(parameterContent(nestedGroupsBlock, 'plain').trim()).toBe('hello');
    expect(parameterContent(nestedGroupsBlock, 'scripted')).toMatch(
      /^\s*<operaton:script scriptFormat="groovy">\s*a \+ b\s*<\/operaton:script>\s*$/,
    );
    expect(parameterContent(nestedGroupsBlock, 'nested')).toMatch(
      new RegExp(
        [
          '^\\s*<operaton:list>',
          '<operaton:value>\\s*first\\s*</operaton:value>',
          '<operaton:map>',
          '<operaton:entry key="inner">\\s*x\\s*</operaton:entry>',
          '<operaton:entry key="deeper">',
          '<operaton:list>',
          '<operaton:value>\\s*z\\s*</operaton:value>',
          '</operaton:list>',
          '</operaton:entry>',
          '</operaton:map>',
          '</operaton:list>\\s*$',
        ].join('\\s*'),
      ),
    );
    expect(parameterContent(nestedGroupsBlock, 'result')).toMatch(
      /^\s*<operaton:map>\s*<operaton:entry key="code">\s*200\s*<\/operaton:entry>\s*<\/operaton:map>\s*$/,
    );
  });
});

describe('irToXml: listeners', () => {
  it('writes every binding form with its attributes unprefixed on the namespaced element', () => {
    // A prefixed attribute here would be one the engine ignores, and the
    // parsed tree would report the property either way, so this reads the text.
    for (const listener of listenerTags(nestedGroupsBlock)) {
      expect(listener).not.toMatch(/\soperaton:/);
    }
    expect(nestedGroupsBlock).toMatch(
      /<operaton:executionListener event="start" class="com\.example\.Enter"\s*\/>/,
    );
    expect(nestedGroupsBlock).toMatch(
      /<operaton:taskListener event="create" expression="\$\{audit\.log\(\)\}"\s*\/>/,
    );
    expect(nestedGroupsBlock).toMatch(
      /<operaton:taskListener id="Review_timeout_1" event="timeout" delegateExpression="\$\{escalate\}"\s*>/,
    );
    expect(nestedGroupsBlock).toMatch(
      /<operaton:executionListener event="end">\s*<operaton:script scriptFormat="javascript">\s*log\(1\);\s*<\/operaton:script>\s*<\/operaton:executionListener>/,
    );
    expect(nestedGroupsBlock).toMatch(
      /<operaton:taskListener id="Review_timeout_1" event="timeout"[^>]*>\s*<bpmn:timerEventDefinition>\s*<bpmn:timeDuration[^>]*>\s*PT2H\s*<\/bpmn:timeDuration>\s*<\/bpmn:timerEventDefinition>\s*<\/operaton:taskListener>/,
    );
  });

  it('every timeout listener gets its own id, stepping around an id the document already holds', async () => {
    const timeout = (className: string, duration: string) => ({
      event: 'timeout' as const,
      binding: classBinding(className),
      timer: timerDef('duration', duration),
    });
    const xmlStr = await irToXml(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'userTask',
            id: 'Review',
            taskListeners: [
              timeout('x.A', 'PT1H'),
              { event: 'create', binding: classBinding('x.C') },
              timeout('x.B', 'PT2H'),
            ],
          },
          { kind: 'userTask', id: 'Review_timeout_2' },
          { kind: 'endEvent', id: 'E' },
        ],
        flowChain('S', 'Review', 'Review_timeout_2', 'E'),
      ),
    );
    expect(listenerTags(extensionBlock(xmlStr))).toEqual([
      '<operaton:taskListener id="Review_timeout_1" event="timeout" class="x.A">',
      '<operaton:taskListener event="create" class="x.C" />',
      '<operaton:taskListener id="Review_timeout_2_2" event="timeout" class="x.B">',
    ]);
  });
});

/** One class-bound `operaton:field`, in the two XML value forms a field takes. */
const STRING_FIELD_TAG =
  /<operaton:field name="greeting" stringValue="hello"\s*\/>/;
const EXPRESSION_FIELD_TAG =
  /<operaton:field name="greeting">\s*<operaton:expression>\$\{x\}<\/operaton:expression>\s*<\/operaton:field>/;
const DEFERRED_EXPRESSION_FIELD_TAG =
  /<operaton:field name="greeting">\s*<operaton:expression>#\{x\}<\/operaton:expression>\s*<\/operaton:field>/;

describe('irToXml: field injection', () => {
  type Carrier = 'service task' | 'execution listener' | 'task listener';

  /** A minimal process planting `binding` on the carrier the row names. */
  const carrierIr = (carrier: Carrier, binding: CodeBinding): BpmnProcess => {
    switch (carrier) {
      case 'service task':
        return around({ kind: 'serviceTask', id: 'Task', binding });
      case 'execution listener':
        return around({
          kind: 'serviceTask',
          id: 'Task',
          binding: classBinding('com.example.Impl'),
          executionListeners: [{ event: 'start', binding }],
        });
      case 'task listener':
        return around({
          kind: 'userTask',
          id: 'Task',
          taskListeners: [{ event: 'create', binding }],
        });
    }
  };

  it.each([
    [
      'a literal value on a class-bound service task writes the stringValue attribute',
      'service task',
      'hello',
      STRING_FIELD_TAG,
    ],
    [
      'a raw expression value on a class-bound service task writes an operaton:expression child',
      'service task',
      '${x}',
      EXPRESSION_FIELD_TAG,
    ],
    [
      'a #{...} value on a class-bound service task writes an operaton:expression child too',
      'service task',
      '#{x}',
      DEFERRED_EXPRESSION_FIELD_TAG,
    ],
    [
      'a literal value on a class-bound execution listener writes the stringValue attribute',
      'execution listener',
      'hello',
      STRING_FIELD_TAG,
    ],
    [
      'a raw expression value on a class-bound execution listener writes an operaton:expression child',
      'execution listener',
      '${x}',
      EXPRESSION_FIELD_TAG,
    ],
    [
      'a literal value on a class-bound task listener writes the stringValue attribute',
      'task listener',
      'hello',
      STRING_FIELD_TAG,
    ],
    [
      'a raw expression value on a class-bound task listener writes an operaton:expression child',
      'task listener',
      '${x}',
      EXPRESSION_FIELD_TAG,
    ],
  ] as const)('%s', async (_title, carrier, value, expected) => {
    const binding = {
      ...classBinding('com.example.Impl'),
      fields: [{ name: 'greeting', value }],
    };
    const xml = await irToXml(carrierIr(carrier, binding));
    expect(xml).toMatch(expected);
  });

  it('places element-level fields before the operaton:inputOutput block, both under one wrapper', async () => {
    const xml = await irToXml(
      around({
        kind: 'serviceTask',
        id: 'Task',
        binding: {
          ...classBinding('com.example.Impl'),
          fields: [{ name: 'greeting', value: 'hello' }],
        },
        inputParameters: [ioParam('amount', textValue('${total}'))],
      }),
    );
    const block = extensionBlock(xml);
    expect(block.indexOf('<operaton:field')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('<operaton:field')).toBeLessThan(
      block.indexOf('<operaton:inputOutput>'),
    );
  });
});

describe('irToXml: user task formRef', () => {
  it.each([
    [
      'a latest binding writes formRef and formRefBinding, no version',
      { kind: 'latest' },
      { formRef: 'review-form', formRefBinding: 'latest' },
    ],
    [
      'a deployment binding writes formRef and formRefBinding, no version',
      { kind: 'deployment' },
      { formRef: 'review-form', formRefBinding: 'deployment' },
    ],
    [
      'a pinned version writes all three formRef* attributes',
      { kind: 'version', version: '3' },
      {
        formRef: 'review-form',
        formRefBinding: 'version',
        formRefVersion: '3',
      },
    ],
  ] as const)('%s', async (_title, binding, expected) => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Task',
        formRef: { key: 'review-form', binding: binding as VersionBinding },
      }),
    );
    const node = await engineNode(xml, 'Task');
    expect(pick(node, ['formRef', 'formRefBinding', 'formRefVersion'])).toEqual(
      expected,
    );
  });
});

describe('irToXml: form field constraints, values, pattern and properties', () => {
  it('serializes every extra a form field carries, in the descriptor order properties, validation, values', async () => {
    const field: FormField = {
      id: 'plan',
      type: 'enum',
      label: 'Plan',
      defaultValue: 'basic',
      properties: [{ key: 'description', value: 'Sets the fee' }],
      constraints: [
        { name: 'required' },
        { name: 'validator', config: 'com.example.Check' },
      ],
      values: [{ id: 'basic', label: 'Basic' }, { id: 'plus' }],
    };
    const xml = await irToXml(
      around({ kind: 'userTask', id: 'Task', formFields: [field] }),
    );
    expect(xml)
      .toContain(`<operaton:formField id="plan" label="Plan" type="enum" defaultValue="basic">
            <operaton:properties>
              <operaton:property id="description" value="Sets the fee" />
            </operaton:properties>
            <operaton:validation>
              <operaton:constraint name="required" />
              <operaton:constraint name="validator" config="com.example.Check" />
            </operaton:validation>
            <operaton:value id="basic" name="Basic" />
            <operaton:value id="plus" />
          </operaton:formField>`);
  });

  it('writes datePattern and constraints in IR order, and no empty properties/validation/values for a field with none', async () => {
    const dateField: FormField = {
      id: 'birthDate',
      type: 'date',
      datePattern: 'dd/MM/yyyy',
    };
    const numberField: FormField = {
      id: 'amount',
      type: 'number',
      constraints: [
        { name: 'min', config: '0' },
        { name: 'max', config: '5000' },
      ],
    };
    const plainField: FormField = { id: 'note', type: 'string' };
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Task',
        formFields: [dateField, numberField, plainField],
      }),
    );
    expect(xml).toContain(
      '<operaton:formField id="birthDate" type="date" datePattern="dd/MM/yyyy" />',
    );
    expect(xml).toContain(`<operaton:formField id="amount" type="long">
            <operaton:validation>
              <operaton:constraint name="min" config="0" />
              <operaton:constraint name="max" config="5000" />
            </operaton:validation>
          </operaton:formField>`);
    expect(xml).toContain('<operaton:formField id="note" type="string" />');
  });
});

describe('irToXml: extension-element assembly order', () => {
  it('emits every group a user task carries under one wrapper in canonical order', async () => {
    expect(nestedGroupsXml.match(/<bpmn:extensionElements/g)).toHaveLength(1);

    const review = await engineNode(nestedGroupsXml, 'Review');
    expect(review.extensionElements?.values.map((v) => v.$type)).toEqual([
      'operaton:InputOutput',
      'operaton:FormData',
      'operaton:ExecutionListener',
      'operaton:ExecutionListener',
      'operaton:TaskListener',
      'operaton:TaskListener',
      'operaton:FailedJobRetryTimeCycle',
    ]);
  });

  it("places a call activity's io block before its mappings and its retry cycle last", async () => {
    const callXml = await irToXml(
      minimalCallIr({
        kind: 'callActivity',
        id: 'CallSub',
        calledElement: 'sub-process',
        inputParameters: [ioParam('amount', textValue('${total}'))],
        inMappings: [{ kind: 'all' }],
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.Enter') },
        ],
        retryCycle: 'R5/PT1M',
      }),
    );
    const call = await engineNode(callXml, 'CallSub');
    expect(call.extensionElements?.values.map((v) => v.$type)).toEqual([
      'operaton:InputOutput',
      'operaton:In',
      'operaton:ExecutionListener',
      'operaton:FailedJobRetryTimeCycle',
    ]);
  });

  it('emits nothing but the io block for a node carrying only parameters', async () => {
    const soloXml = await irToXml(
      processIr(
        'io-only',
        [
          { kind: 'startEvent', id: 'Start' },
          {
            kind: 'serviceTask',
            id: 'Fetch',
            binding: externalBinding('fetch'),
            outputParameters: [ioParam('body', textValue('${response}'))],
          },
          { kind: 'endEvent', id: 'End' },
        ],
        flowChain('Start', 'Fetch', 'End'),
      ),
    );
    expect(soloXml.match(/<bpmn:extensionElements/g)).toHaveLength(1);
    expect(extensionBlock(soloXml)).toMatch(
      /^<bpmn:extensionElements>\s*<operaton:inputOutput>\s*<operaton:outputParameter name="body">\s*\$\{response\}\s*<\/operaton:outputParameter>\s*<\/operaton:inputOutput>\s*<\/bpmn:extensionElements>$/,
    );
  });
});

/** One of each task kind, wired `Start -> Step -> Wait -> Notify -> Rate -> End`. */
const taskKindsIr: BpmnProcess = chained([
  { kind: 'startEvent', id: 'Start' },
  { kind: 'task', id: 'Step' },
  { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
  {
    kind: 'serviceTask',
    id: 'Notify',
    element: 'send',
    binding: classBinding('com.example.Notify'),
  },
  {
    kind: 'serviceTask',
    id: 'Rate',
    element: 'businessRule',
    binding: {
      kind: 'decision',
      decisionRef: 'riskRating',
      binding: { kind: 'version', version: '3' },
      mapDecisionResult: 'singleEntry',
    },
    resultVariable: 'risk',
  },
  { kind: 'endEvent', id: 'End' },
]);

describe('irToXml: task kinds', () => {
  let taskKindsXml: string;
  let defs: Moddle;

  beforeAll(async () => {
    taskKindsXml = await irToXml(taskKindsIr);
    defs = await parseDefinitionsWithOperaton(taskKindsXml);
  });

  it('emits a bpmn:task carrying nothing beyond its id and derived name', () => {
    expect(taskKindsXml).toContain('<bpmn:task id="Step" name="Step">');
  });

  it('points a receive task at the bpmn:Message root synthesized from its name, and re-reads clean', async () => {
    const messages = rootsOfType(defs, 'bpmn:Message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.name).toBe('OrderPaid');
    const wait = requireDeep(defs, 'Wait');
    expect(wait.$type).toBe('bpmn:ReceiveTask');
    expect(wait.messageRef?.id).toBe('Message_OrderPaid');
    await expectNoModdleWarnings(taskKindsXml);
  });

  it('shares one bpmn:Message root between a receive task and an await of the same name', async () => {
    const shared = await parseDefinitionsWithOperaton(
      await irToXml(
        chained([
          { kind: 'startEvent', id: 'Start' },
          { kind: 'receiveTask', id: 'Wait', messageName: 'OrderPaid' },
          typedEvent(
            'intermediateCatchEvent',
            'Again',
            messageDef('OrderPaid'),
          ),
          { kind: 'endEvent', id: 'End' },
        ]),
      ),
    );
    expect(rootsOfType(shared, 'bpmn:Message')).toHaveLength(1);
    expect(requireDeep(shared, 'Wait').messageRef?.id).toBe(
      'Message_OrderPaid',
    );
    expect(soleDef(requireDeep(shared, 'Again')).messageRef?.id).toBe(
      'Message_OrderPaid',
    );
  });

  it('gives a nameless receive task neither a messageRef nor a root', async () => {
    const xml = await irToXml(around({ kind: 'receiveTask', id: 'Wait' }));
    expect(extractNodeBlock(xml, 'Wait')).not.toContain('messageRef');
    const nameless = await parseDefinitionsWithOperaton(xml);
    expect(rootsOfType(nameless, 'bpmn:Message')).toHaveLength(0);
  });
});

/** The loop every kind in the parameterized fixture carries. */
const OVER_LINES: LoopCharacteristics = {
  collection: 'lines',
  elementVariable: 'line',
};

/** What {@link OVER_LINES} serializes to when the loop carries nothing else. */
const OVER_LINES_TAG =
  '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line" />';

/** One repeated element of every kind that can carry a loop, wired head to tail. */
const repeatedKindsIr: BpmnProcess = chained([
  { kind: 'startEvent', id: 'Start' },
  { kind: 'task', id: 'Step', loop: OVER_LINES },
  { kind: 'userTask', id: 'Approve', loop: OVER_LINES },
  {
    kind: 'serviceTask',
    id: 'Notify',
    element: 'send',
    binding: classBinding('com.example.Notify'),
    loop: OVER_LINES,
  },
  {
    kind: 'scriptTask',
    id: 'Compute',
    format: 'javascript',
    code: 'var x = 1;',
    loop: OVER_LINES,
  },
  { kind: 'receiveTask', id: 'Wait', loop: OVER_LINES },
  {
    ...chainedSub(
      'Fulfil',
      [
        { kind: 'startEvent', id: 'SubStart' },
        {
          kind: 'serviceTask',
          id: 'Pick',
          binding: classBinding('com.example.Pick'),
        },
        { kind: 'endEvent', id: 'SubEnd' },
      ],
      { prefix: 'SubFlow' },
    ),
    loop: OVER_LINES,
  },
  {
    kind: 'callActivity',
    id: 'Regional',
    calledElement: 'regional-report',
    loop: OVER_LINES,
  },
  { kind: 'endEvent', id: 'End' },
]);

describe('irToXml: multi-instance loop characteristics', () => {
  let repeatedXml: string;

  beforeAll(async () => {
    repeatedXml = await irToXml(repeatedKindsIr);
  });

  it.each([
    ['Step', '<bpmn:task'],
    ['Approve', '<bpmn:userTask'],
    ['Notify', '<bpmn:sendTask'],
    ['Compute', '<bpmn:scriptTask'],
    ['Wait', '<bpmn:receiveTask'],
    ['Fulfil', '<bpmn:subProcess'],
    ['Regional', '<bpmn:callActivity'],
  ])('writes the loop child under the own tag of %s', (id, tag) => {
    expect(extractNodeBlock(repeatedXml, id).split(' ')[0]).toBe(tag);
    expect(loopBlock(repeatedXml, id)).toBe(OVER_LINES_TAG);
  });

  it('re-reads through the Operaton descriptor with no moddle warnings', async () => {
    await expectNoModdleWarnings(repeatedXml);
  });

  it.each<[string, LoopCharacteristics, string | undefined]>([
    [
      'a sequential loop writes isSequential before the collection',
      { ...OVER_LINES, sequential: true },
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="lines" operaton:elementVariable="line" />',
    ],
    [
      'a literal count is the loopCardinality body',
      { cardinality: '3' },
      '<bpmn:multiInstanceLoopCharacteristics>\n' +
        '        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'an expression count is the loopCardinality body',
      { cardinality: '${n}' },
      '<bpmn:multiInstanceLoopCharacteristics>\n' +
        '        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">${n}</bpmn:loopCardinality>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'a completion condition is the completionCondition body, escaped by the writer',
      { ...OVER_LINES, completionCondition: '${nrOfCompletedInstances >= 2}' },
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line">\n' +
        '        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">${nrOfCompletedInstances &gt;= 2}</bpmn:completionCondition>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>',
    ],
    [
      'neither a count nor a collection writes no loop child',
      { sequential: true, completionCondition: '${done}' },
      undefined,
    ],
  ])('%s', async (_title, loop, expected) => {
    const xml = await irToXml(
      around({ kind: 'userTask', id: 'Approve', loop }),
    );
    expect(loopBlock(xml, 'Approve')).toBe(expected);
  });

  it("a repetition carrying per-run settings writes them on the loop element, beside the step's own", async () => {
    const xml = await irToXml(
      around({
        kind: 'serviceTask',
        id: 'Step',
        binding: exprBinding('${step.run(execution)}'),
        asyncBefore: true,
        asyncAfter: true,
        jobPriority: '20',
        retryCycle: 'R3/PT5M',
        resultVariable: 'outcome',
        loop: {
          collection: 'lines',
          elementVariable: 'line',
          asyncBefore: true,
          asyncAfter: true,
          exclusive: false,
          retryCycle: 'R2/PT1M',
        },
      }),
    );
    expect(extractNodeBlock(xml, 'Step')).toBe(
      '<bpmn:serviceTask id="Step" name="Step" operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:jobPriority="20" operaton:expression="${step.run(execution)}" operaton:resultVariable="outcome">\n' +
        '      <bpmn:extensionElements>\n' +
        '        <operaton:failedJobRetryTimeCycle>R3/PT5M</operaton:failedJobRetryTimeCycle>\n' +
        '      </bpmn:extensionElements>\n' +
        '      <bpmn:incoming>F1</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
        '      <bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line" operaton:asyncBefore="true" operaton:asyncAfter="true" operaton:exclusive="false">\n' +
        '        <bpmn:extensionElements>\n' +
        '          <operaton:failedJobRetryTimeCycle>R2/PT1M</operaton:failedJobRetryTimeCycle>\n' +
        '        </bpmn:extensionElements>\n' +
        '      </bpmn:multiInstanceLoopCharacteristics>\n' +
        '    </bpmn:serviceTask>',
    );

    const bareXml = await irToXml(
      around({ kind: 'userTask', id: 'Approve', loop: OVER_LINES }),
    );
    expect(extractNodeBlock(bareXml, 'Approve')).toBe(
      '<bpmn:userTask id="Approve" name="Approve">\n' +
        '      <bpmn:incoming>F1</bpmn:incoming>\n' +
        '      <bpmn:outgoing>F2</bpmn:outgoing>\n' +
        `      ${OVER_LINES_TAG}\n` +
        '    </bpmn:userTask>',
    );
  });
});

/**
 * `PStart -> Book -> PEnd`, where the block `Book` ends in a cancel and carries
 * a cancel boundary. Its body holds a sub-process of its own, so the expansion
 * hint has to descend rather than stop at the block.
 */
function giveUpIr(element?: 'transaction'): BpmnProcess {
  return processIr(
    'proc',
    [
      { kind: 'startEvent', id: 'PStart' },
      {
        ...chainedSub('Book', [
          { kind: 'startEvent', id: 'TxStart' },
          { kind: 'userTask', id: 'Charge' },
          chainedSub('Settle', [
            { kind: 'startEvent', id: 'SStart' },
            { kind: 'userTask', id: 'Ledger' },
            { kind: 'endEvent', id: 'SEnd' },
          ]),
          typedEvent('endEvent', 'GiveUp', { kind: 'cancel' }),
        ]),
        ...(element === undefined ? {} : { element }),
      },
      { kind: 'endEvent', id: 'PEnd' },
      boundaryEvent('Boundary_Book_cancel', 'Book', { kind: 'cancel' }),
      { kind: 'endEvent', id: 'Escaped' },
    ],
    [
      edge('PStart', 'Book', { id: 'SF_PStart_Book' }),
      edge('Book', 'PEnd', { id: 'SF_Book_PEnd' }),
      edge('Boundary_Book_cancel', 'Escaped', { id: 'SF_Boundary_Escaped' }),
    ],
  );
}

describe('irToXml: blocks that can be given up', () => {
  let giveUpXml: string;

  beforeAll(async () => {
    giveUpXml = await irToXml(giveUpIr('transaction'));
  });

  it('writes the block under bpmn:transaction and a plain one under bpmn:subProcess, children alike, re-read clean', async () => {
    const transaction = childById(await parseProcessTree(giveUpXml), 'Book');
    const plain = childById(
      await parseProcessTree(await irToXml(giveUpIr())),
      'Book',
    );
    expect(transaction.$type).toBe('bpmn:Transaction');
    expect(plain.$type).toBe('bpmn:SubProcess');
    expect(giveUpXml).toContain('<bpmn:transaction id="Book"');

    expect(structureOf(transaction)).toEqual(structureOf(plain));
    await expectNoModdleWarnings(giveUpXml);
  });

  it('emits a cancel definition on the end inside the block and on the boundary attached to it', async () => {
    const defs = await parseDefinitionsWithOperaton(giveUpXml);
    expect(soleDef(requireDeep(defs, 'GiveUp')).$type).toBe(
      'bpmn:CancelEventDefinition',
    );
    const boundary = requireDeep(defs, 'Boundary_Book_cancel');
    expect(soleDef(boundary).$type).toBe('bpmn:CancelEventDefinition');
    expect(boundary.attachedToRef?.id).toBe('Book');
  });

  it('lays every child of the block out inside the block, nested block included', async () => {
    const shapes = await parseDiShapesById(giveUpXml);
    expectInside(shapes, 'Book', ['TxStart', 'Charge', 'Settle', 'GiveUp']);
    expectInside(shapes, 'Settle', ['SStart', 'Ledger', 'SEnd']);
  });

  it('writes the engine attribute, the mapping and the loop the sub-process case writes', async () => {
    const repeated = giveUpIr('transaction');
    const block = repeated.flowElements[1] as Extract<
      FlowElement,
      { kind: 'subProcess' }
    >;
    repeated.flowElements[1] = {
      ...block,
      asyncBefore: true,
      inputParameters: [ioParam('seed', textValue('1'))],
      loop: { collection: 'lines', elementVariable: 'line' },
    };
    const xml = await irToXml(repeated);
    const node = extractNodeBlock(xml, 'Book');
    expect(node.split('\n')[0]).toBe(
      '<bpmn:transaction id="Book" name="Book" operaton:asyncBefore="true">',
    );
    expect(extensionBlock(node)).toBe(
      '<bpmn:extensionElements>\n' +
        '        <operaton:inputOutput>\n' +
        '          <operaton:inputParameter name="seed">1</operaton:inputParameter>\n' +
        '        </operaton:inputOutput>\n' +
        '      </bpmn:extensionElements>',
    );
    expect(loopBlock(xml, 'Book')).toBe(
      '<bpmn:multiInstanceLoopCharacteristics operaton:collection="lines" operaton:elementVariable="line" />',
    );
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Re-read with the Operaton extension registered, the stricter read: an
 * `operaton:` name the descriptor does not declare draws a warning.
 */
async function expectNoModdleWarnings(xmlStr: string): Promise<void> {
  const { warnings } = await createModdle().fromXML(xmlStr);
  expect(warnings).toEqual([]);
}

/** The listed properties of a parsed node, the `undefined` ones left out. */
function pick(
  node: Moddle,
  keys: readonly (keyof Moddle)[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => node[k] !== undefined).map((k) => [k, node[k]]),
  );
}

/** A container's children as `<type> <id>`, in document order. */
function structureOf(container: Moddle): string[] {
  return (container.flowElements ?? []).map((e) => `${e.$type} ${e.id}`);
}

/** The text of every `bpmn:documentation` child. */
function documentationOf(node: Moddle): string[] {
  return (node.documentation ?? []).map((doc) => doc.text ?? '');
}

/** The `<bpmn:incoming>`/`<bpmn:outgoing>` child count of one flow node. */
function degreeOf(xmlStr: string, id: string): { in: number; out: number } {
  const block = extractNodeBlock(xmlStr, id);
  return {
    in: (block.match(/<bpmn:incoming>/g) ?? []).length,
    out: (block.match(/<bpmn:outgoing>/g) ?? []).length,
  };
}

/** How many `bpmndi:BPMNDiagram` blocks: one, since the layouter's diagram replaces the seeded expansion stub. */
function diagramCount(xmlStr: string): number {
  return (xmlStr.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length;
}

/**
 * The sole `<bpmn:extensionElements>` block of a document, as raw serialized
 * text. Assertions on namespace prefixes have to read the text: the parsed
 * moddle object model reports a property whether or not its prefix was written
 * the way the engine expects.
 */
function extensionBlock(xmlStr: string): string {
  const closeTag = '</bpmn:extensionElements>';
  const open = xmlStr.indexOf('<bpmn:extensionElements>');
  const close = xmlStr.indexOf(closeTag);
  if (open === -1 || close === -1) {
    throw new Error('No <bpmn:extensionElements> block in the output.');
  }
  return xmlStr.slice(open, close + closeTag.length);
}

/** The serialized content of one named input or output parameter. */
function parameterContent(block: string, name: string): string {
  const match = block.match(
    new RegExp(
      `<operaton:(in|out)putParameter name="${name}">([\\s\\S]*?)</operaton:\\1putParameter>`,
    ),
  );
  if (match === null) {
    throw new Error(`No parameter named "${name}" in the extension block.`);
  }
  return match[2]!;
}

/** Every listener opening tag in a block, as raw text (attributes included). */
function listenerTags(block: string): string[] {
  return [...block.matchAll(/<operaton:(?:execution|task)Listener[^>]*>/g)].map(
    (m) => m[0],
  );
}

/** The `bpmn:Definitions` root, Operaton settings resolved as typed properties. */
async function parseDefinitionsWithOperaton(xmlStr: string): Promise<Moddle> {
  const { rootElement } = await createModdle().fromXML(xmlStr);
  return rootElement as unknown as Moddle;
}

/** Serialize an IR and parse the definitions back, Operaton registered. */
const defsOf = async (ir: BpmnProcess): Promise<Moddle> =>
  parseDefinitionsWithOperaton(await irToXml(ir));

/** Every root element of a given `$type` (e.g. `bpmn:Error`). */
function rootsOfType(defs: Moddle, $type: string): Moddle[] {
  return defs.rootElements.filter((r) => r.$type === $type);
}

/** Recursively locate a flow node by id anywhere under the process, or throw. */
function requireDeep(defs: Moddle, id: string): Moddle {
  const found = deepFind(processOf(defs), id);
  if (found === undefined) {
    throw new Error(`Flow node id="${id}" not found in the process tree.`);
  }
  return found;
}

function deepFind(container: Moddle, id: string): Moddle | undefined {
  for (const el of container.flowElements ?? []) {
    if (el.id === id) return el;
    const nested = deepFind(el, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The sole event definition on an event node, whatever its kind. */
function soleDef(node: Moddle): Moddle {
  const def = (node.eventDefinitions ?? [])[0];
  if (def === undefined) {
    throw new Error(`Node id="${node.id}" carries no event definition.`);
  }
  return def;
}

/** Minimal `start -> call -> end` wrapper around one call-activity node. */
function minimalCallIr(call: BpmnProcess['flowElements'][number]): BpmnProcess {
  return processIr(
    'caller',
    [
      { kind: 'startEvent', id: 'Start' },
      call,
      { kind: 'endEvent', id: 'End' },
    ],
    [
      { id: 'F_Start_Call', sourceRef: 'Start', targetRef: call.id },
      { id: 'F_Call_End', sourceRef: call.id, targetRef: 'End' },
    ],
  ) satisfies BpmnProcess;
}

/** The root `bpmn:Process`, Operaton settings resolved as typed properties. */
async function parseProcessTreeWithOperaton(xmlStr: string): Promise<Moddle> {
  return processOf(await parseDefinitionsWithOperaton(xmlStr));
}

/** A DI shape's bounds, as parsed from `dc:Bounds`. */
interface DiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One `bpmndi:BPMNShape`, keyed by the id of the BPMN element it lays out. */
interface DiShape {
  bpmnElementId: string;
  bounds: DiBounds;
}

/** Every `bpmndi:BPMNShape` of the diagram, keyed by the id of the element it lays out. */
async function parseDiShapesById(
  xmlStr: string,
): Promise<Map<string, DiShape>> {
  const moddle = new BpmnModdle({});
  const { rootElement } = await moddle.fromXML(xmlStr);
  const definitions = rootElement as unknown as {
    diagrams?: Array<{
      plane?: {
        planeElement?: Array<{
          $type: string;
          bpmnElement?: { id: string };
          bounds?: DiBounds;
        }>;
      };
    }>;
  };
  const planeElements = definitions.diagrams?.[0]?.plane?.planeElement ?? [];
  const shapes = new Map<string, DiShape>();
  for (const el of planeElements) {
    if (el.$type !== 'bpmndi:BPMNShape') continue;
    if (el.bpmnElement === undefined || el.bounds === undefined) continue;
    shapes.set(el.bpmnElement.id, {
      bpmnElementId: el.bpmnElement.id,
      bounds: el.bounds,
    });
  }
  return shapes;
}

/** Look up a DI shape by the id of the BPMN element it represents, or throw. */
function requireShape(
  shapes: Map<string, DiShape>,
  bpmnElementId: string,
): DiShape {
  const shape = shapes.get(bpmnElementId);
  if (shape === undefined) {
    throw new Error(
      `No bpmndi:BPMNShape found for bpmnElement id="${bpmnElementId}".`,
    );
  }
  return shape;
}

/** Every named child shape lies strictly inside the parent's shape. */
function expectInside(
  shapes: Map<string, DiShape>,
  parentId: string,
  childIds: string[],
): void {
  const parent = requireShape(shapes, parentId);
  for (const childId of childIds) {
    expect(
      boundsStrictlyInside(requireShape(shapes, childId).bounds, parent.bounds),
    ).toBe(true);
  }
}

/** Whether `inner` is fully, strictly contained within `outer` (no touching edges). */
function boundsStrictlyInside(inner: DiBounds, outer: DiBounds): boolean {
  return (
    inner.x > outer.x &&
    inner.y > outer.y &&
    inner.x + inner.width < outer.x + outer.width &&
    inner.y + inner.height < outer.y + outer.height
  );
}

/**
 * One loose type over every parsed moddle node, so a test reads references and
 * Operaton settings as typed properties instead of casting at every hop.
 */
interface Moddle {
  $type: string;
  /** Attributes the descriptor does not declare for this type land here. */
  $attrs: Record<string, string>;
  id?: string;
  name?: string;
  body?: string;
  text?: string;
  documentation?: Moddle[];
  rootElements: Moddle[];
  flowElements?: Moddle[];
  eventDefinitions?: Moddle[];
  extensionElements?: { values: Moddle[] };
  incoming?: Moddle[];
  outgoing?: Moddle[];
  sourceRef?: Moddle;
  targetRef?: Moddle;
  default?: Moddle;
  attachedToRef?: Moddle;
  errorRef?: Moddle;
  escalationRef?: Moddle;
  messageRef?: Moddle;
  signalRef?: Moddle;
  condition?: Moddle;
  timeDuration?: Moddle;
  timeDate?: Moddle;
  timeCycle?: Moddle;
  errorCode?: string;
  errorMessage?: string;
  errorCodeVariable?: string;
  errorMessageVariable?: string;
  escalationCode?: string;
  escalationCodeVariable?: string;
  isInterrupting?: boolean;
  triggeredByEvent?: boolean;
  versionTag?: string;
  historyTimeToLive?: string;
  candidateStarterUsers?: string;
  candidateStarterGroups?: string;
  formRef?: string;
  formRefBinding?: string;
  formRefVersion?: string;
  calledElement?: string;
  calledElementBinding?: string;
  calledElementVersion?: string;
  variableMappingClass?: string;
  variableMappingDelegateExpression?: string;
  source?: string;
  sourceExpression?: string;
  variables?: string;
  target?: string;
  businessKey?: string;
  local?: boolean;
}

/** The root `bpmn:Process` of a parsed `bpmn:Definitions`, or throw. */
function processOf(rootElement: unknown): Moddle {
  const { rootElements } = rootElement as { rootElements: Moddle[] };
  const proc = rootElements.find((e) => e.$type === 'bpmn:Process');
  if (proc === undefined) {
    throw new Error('No bpmn:Process found in parsed output.');
  }
  return proc;
}

/** The root `bpmn:Process` as raw `bpmn-moddle` reads it, no extension registered. */
async function parseProcessTree(xmlStr: string): Promise<Moddle> {
  const { rootElement } = await new BpmnModdle({}).fromXML(xmlStr);
  return processOf(rootElement);
}

/** Find a direct child flow element (node or flow) of a container by id. */
function childById(container: Moddle, id: string): Moddle {
  const found = (container.flowElements ?? []).find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`Child id="${id}" not found in ${container.$type}.`);
  }
  return found;
}

/**
 * The serialized text of one flow node, found by its `id` attribute. Reading
 * the text is how a test sees an absent attribute: on read, moddle fills the
 * schema default (`isInterrupting`, `cancelActivity`, `textFormat`) either way.
 */
function extractNodeBlock(xml: string, nodeId: string): string {
  const idPos = xml.indexOf(`id="${nodeId}"`);
  if (idPos === -1) {
    throw new Error(`Node id="${nodeId}" not found in XML output.`);
  }
  return elementAt(xml, xml.lastIndexOf('<', idPos));
}

/** The `bpmn:multiInstanceLoopCharacteristics` child of one flow node, or `undefined` for none. */
function loopBlock(xml: string, nodeId: string): string | undefined {
  const node = extractNodeBlock(xml, nodeId);
  const start = node.indexOf('<bpmn:multiInstanceLoopCharacteristics');
  return start === -1 ? undefined : elementAt(node, start);
}

/** The element whose opening tag starts at `tagStart`, through its close tag or self-close. */
function elementAt(xml: string, tagStart: number): string {
  const tagName = /^<([^\s/>]+)/.exec(xml.slice(tagStart))?.[1];
  const openTagEnd = xml.indexOf('>', tagStart);
  if (tagName === undefined || openTagEnd === -1) {
    throw new Error(`No element opens at position ${tagStart}.`);
  }
  // Decided from the opening tag alone: scanning ahead for the first `/>`
  // would stop at a self-closing child, such as a repeated activity's loop.
  if (xml[openTagEnd - 1] === '/') {
    return xml.slice(tagStart, openTagEnd + 1);
  }
  const closeTag = `</${tagName}>`;
  const closeTagPos = xml.indexOf(closeTag, openTagEnd);
  if (closeTagPos === -1) {
    throw new Error(`Unterminated <${tagName}> at position ${tagStart}.`);
  }
  return xml.slice(tagStart, closeTagPos + closeTag.length);
}
