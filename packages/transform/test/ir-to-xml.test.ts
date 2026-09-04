/**
 * `irToXml` calls `bpmn-auto-layout`, which performs real DOM layout, so every
 * test here exercises the full serializer. The shared `xml` is serialized from
 * an import-shaped IR, which depends on neither the parser nor the desugarer;
 * the golden diff runs the whole `parse -> astToIr -> irToXml` pipeline.
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

import { irToXml } from '../src/ir-to-xml.js';
import { astToIr } from '../src/ast-to-ir.js';
import {
  around,
  boundaryEvent,
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
  EventDefinition,
  FlowElement,
  LoopCharacteristics,
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

/** The handwritten golden as imported, whose name import derives and drops. */
const importShapedIr: BpmnProcess = {
  ...HANDWRITTEN_IMPORT_IR,
  name: 'Invoice Approval',
};

// ── Shared XML output ────────────────────────────────────────────────────────

let xml: string;

beforeAll(async () => {
  xml = await irToXml(importShapedIr);
});

describe('irToXml: bpmn-moddle round-trip', () => {
  it('irToXml(importShapedIr) parses cleanly via bpmn-moddle.fromXML', async () => {
    await expectNoModdleWarnings(xml);
  });

  it('labels the conditioned flow with its bare condition text', () => {
    // Viewers render a flow's `name`, not its `conditionExpression`, so the
    // condition (minus the `${...}` delimiters) is mirrored as the edge label.
    // `>` may serialize as the numeric (`&#62;`) or named (`&gt;`) entity
    // depending on the writer; decode both so the assertion is encoding-robust.
    const decoded = xml.replace(/(&#62;|&gt;)/g, '>');
    expect(decoded).toContain('name="amount > 1000"');
  });
});

describe('irToXml: Operaton extension attributes', () => {
  it.each([
    'operaton:assignee="demo"',
    'operaton:assignee="manager"',
    'operaton:class="com.example.invoice.AutoApproveDelegate"',
    'operaton:historyTimeToLive="P30D"',
  ])('contains %s', (attribute) => {
    expect(xml).toContain(attribute);
  });

  it('emits the bpmndi:BPMNDiagram block', () => {
    expect(xml).toMatch(/<bpmndi:BPMNDiagram\b/);
  });
});

describe('irToXml: per-node incoming/outgoing graph degree', () => {
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
      // The gateway's two branches, converging on the one end event.
      AmountCheck: { in: 1, out: 2 },
      SeniorApproval: { in: 1, out: 1 },
      AutoApprove: { in: 1, out: 1 },
      Done: { in: 2, out: 0 },
    });
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
    // contract at once: process id, task ids, delegate, assignees, condition.
    // The example holds no sub-process, so it also pins that the DI expansion
    // hint is attached only when one is actually present.
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
    expect(gatewaysXml).toMatch(/<bpmn:inclusiveGateway[^>]*id="Fork"/);
    expect(gatewaysXml).toMatch(/<bpmn:inclusiveGateway[^>]*id="Merge"/);
    expect(gatewaysXml).toMatch(/<bpmn:eventBasedGateway[^>]*id="Race"/);

    const fork = extractNodeBlock(gatewaysXml, 'Fork');
    const merge = extractNodeBlock(gatewaysXml, 'Merge');
    const race = extractNodeBlock(gatewaysXml, 'Race');

    expect(fork).toContain('name="Any that apply"');
    expect(race).toContain('name="First of"');
    expect(fork).toContain('default="F_Fork_C"');
    // A synthesized id must not be humanized into a label.
    expect(merge).not.toContain('name=');
    expect(merge).not.toContain('default=');
    expect(race).not.toContain('default=');

    expect(degreeOf(gatewaysXml, 'Fork').out).toBe(3);
    expect(degreeOf(gatewaysXml, 'Merge').in).toBe(3);
    expect(degreeOf(gatewaysXml, 'Race').out).toBe(2);
  });

  it('writes no engine attribute on either kind, even when the IR literal carries the fields an activity would', async () => {
    // Neither gateway type declares the engine settings, so the fields only
    // reach the serializer through a cast: what is pinned here is that the
    // serializer refuses them by kind rather than by the IR shape.
    const withEngineFields = processIr('engine-on-gateway', [
      {
        kind: 'inclusiveGateway',
        id: 'Fork',
        asyncBefore: true,
        asyncAfter: true,
        exclusive: false,
        jobPriority: '50',
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.L') },
        ],
      },
      {
        kind: 'eventBasedGateway',
        id: 'Race',
        asyncBefore: true,
        executionListeners: [
          { event: 'start', binding: classBinding('com.example.L') },
        ],
      },
    ] as unknown as FlowElement[]);

    const xmlOut = await irToXml(withEngineFields);
    for (const id of ['Fork', 'Race']) {
      const block = extractNodeBlock(xmlOut, id);
      expect(block).not.toContain('operaton:');
      expect(block).not.toContain('extensionElements');
    }
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
    // Every sequence flow keeps its edge: the two new kinds route like a
    // parallel gateway as far as the layout is concerned.
    expect((gatewaysXml.match(/<bpmndi:BPMNEdge/g) ?? []).length).toBe(
      gatewaysIr.sequenceFlows.length,
    );
  });
});

describe('irToXml: serviceTask binding variants', () => {
  it.each([
    [
      'expression binding emits operaton:expression',
      exprBinding('${bean.method(execution)}'),
      ['operaton:expression="${bean.method(execution)}"'],
    ],
    [
      'delegateExpression binding emits operaton:delegateExpression',
      delegateBinding('${myDelegate}'),
      ['operaton:delegateExpression="${myDelegate}"'],
    ],
    [
      'external binding emits operaton:type="external" and operaton:topic',
      externalBinding('shipping'),
      ['operaton:type="external"', 'operaton:topic="shipping"'],
    ],
  ] as const)('%s', async (_title, binding, expected) => {
    const out = await irToXml(
      around({ kind: 'serviceTask', id: 'Task', binding }),
    );
    for (const attribute of expected) {
      expect(out).toContain(attribute);
    }
  });
});

describe('irToXml: scriptTask serialization', () => {
  const scriptIr: BpmnProcess = around(
    scriptTask(
      'Compute',
      'javascript',
      'var total = amount * 2;\nreturn total;',
    ),
  );

  let scriptXml: string;

  beforeAll(async () => {
    scriptXml = await irToXml(scriptIr);
  });

  it('emits a bpmn:scriptTask carrying its format, the body text surviving inside it', () => {
    expect(scriptXml).toMatch(
      /<bpmn:scriptTask[^>]*id="Compute"[^>]*scriptFormat="javascript"/,
    );
    expect(scriptXml).toContain('var total = amount * 2;');
    expect(scriptXml).toContain('return total;');
  });

  it('parses cleanly via bpmn-moddle', async () => {
    await expectNoModdleWarnings(scriptXml);
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
  // Inspected as the semantic element tree, not the DI, which the layout
  // regenerates: the output is parsed back with raw `bpmn-moddle`.
  const nestedIr: BpmnProcess = chained([
    { kind: 'startEvent', id: 'PStart' },
    chainedSub('sub', [
      { kind: 'startEvent', id: 'SubStart' },
      { kind: 'userTask', id: 'Review', name: 'Review', assignee: 'demo' },
      { kind: 'endEvent', id: 'SubEnd' },
    ]),
    { kind: 'endEvent', id: 'PEnd' },
  ]);

  let proc: Moddle;
  let nestedXml: string;

  beforeAll(async () => {
    nestedXml = await irToXml(nestedIr);
    proc = await parseProcessTree(nestedXml);
  });

  it('emits a bpmn:SubProcess holding its own children and flows, the parent holding neither', () => {
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
  });

  it('wires nested children incoming/outgoing to the nested flows', () => {
    const review = childById(childById(proc, 'sub'), 'Review');
    expect((review.incoming ?? []).map((f) => f.id)).toEqual([
      'SF_SubStart_Review',
    ]);
    expect((review.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Review_SubEnd',
    ]);
  });

  it('routes the parent-level flows to the sub-process element itself', () => {
    expect(childById(proc, 'SF_PStart_sub').targetRef?.id).toBe('sub');
    expect(childById(proc, 'SF_sub_PEnd').sourceRef?.id).toBe('sub');
  });

  it('parses cleanly via bpmn-moddle', async () => {
    await expectNoModdleWarnings(nestedXml);
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

  it('serializes two-level nesting recursively', async () => {
    const tree = await parseProcessTree(await irToXml(twoLevelIr));
    const outer = childById(tree, 'Outer');
    expect(outer.$type).toBe('bpmn:SubProcess');
    const inner = childById(outer, 'Inner');
    expect(inner.$type).toBe('bpmn:SubProcess');
    const deep = childById(inner, 'Deep');
    expect(deep.$type).toBe('bpmn:UserTask');
    const outerIds = (outer.flowElements ?? []).map((e) => e.id);
    expect(outerIds).not.toContain('SF_IStart_Deep');
  });
});

describe('irToXml: DI expansion hint for sub-processes', () => {
  // Fed DI-less XML holding a sub-process, `bpmn-auto-layout` renders it
  // collapsed and scatters the children across the root plane, so `irToXml`
  // pre-seeds a `bpmndi:BPMNShape isExpanded="true"` per sub-process.
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
    // The layout-generated diagram replaces the seeded stub rather than
    // joining it.
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
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
    // `irToXml` runs bpmn-auto-layout, so a throw here fails the suite and
    // doubles as the "layout handles a call activity" check.
    callXml = await irToXml(richCallIr);
    const proc = await parseProcessTreeWithOperaton(callXml);
    call = childById(proc, 'CallSub');
  });

  it('emits a bpmn:CallActivity carrying its name, calledElement and the deployment binding', () => {
    expect(call.$type).toBe('bpmn:CallActivity');
    expect(call.name).toBe('Call sub');
    expect(call.calledElement).toBe('sub-process');
    expect(call.calledElementBinding).toBe('deployment');
    // A non-version binding never emits a version attribute.
    expect(call.calledElementVersion).toBeUndefined();
  });

  it('emits the business key, then the in-mappings, then the out-mappings, each with its own attributes', () => {
    // Whole-mapping equality rather than per-field checks: `local` has to be
    // absent everywhere but the one mapping that sets it, and only an exact
    // projection catches it appearing anywhere else.
    expect(
      (call.extensionElements?.values ?? []).map((v) => [
        v.$type,
        mappingAttrs(v),
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

  it('wires the call activity with incoming/outgoing like any activity', () => {
    // Assert on the parsed graph rather than the raw block: a call activity
    // with self-closing `operaton:in` children defeats the string-scanning
    // block extractor, but the wired references are unambiguous.
    expect((call.incoming ?? []).map((f) => f.id)).toEqual(['F_Start_Call']);
    expect((call.outgoing ?? []).map((f) => f.id)).toEqual(['F_Call_End']);
  });

  it('parses cleanly via bpmn-moddle carrying the extension', async () => {
    await expectNoModdleWarnings(callXml);
  });

  it('emits both calledElementBinding and calledElementVersion for a version binding', async () => {
    const ir = minimalCallIr({
      kind: 'callActivity',
      id: 'CallSub',
      calledElement: 'sub',
      binding: { kind: 'version', version: '7' },
    });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub');
    expect(c.calledElementBinding).toBe('version');
    expect(c.calledElementVersion).toBe('7');
  });

  it('emits neither binding attribute nor an extensionElements wrapper for a minimal call', async () => {
    const ir = minimalCallIr(callActivity('CallSub', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub');
    expect(c.calledElementBinding).toBeUndefined();
    expect(c.calledElementVersion).toBeUndefined();
    expect(c.extensionElements).toBeUndefined();
  });

  it('derives a humanized name for an unnamed call activity', async () => {
    const ir = minimalCallIr(callActivity('ProcessPayment', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    // The excluded-name path does not apply to activities: the id humanizes.
    expect(childById(proc, 'ProcessPayment').name).toBe('Process Payment');
  });
});

describe('irToXml: event layer (errors + escalations)', () => {
  /**
   * The whole error/escalation surface at once: a declared error message, an
   * interrupting error handler inside a sub-process, an `alongside` escalation
   * handler beside the main chain, and a throw and an emit of the same two
   * codes. Handlers carry no incoming or outgoing flow: an event sub-process is
   * triggered, not flow-connected.
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
    errorMessages: [{ code: 'PF', message: 'boom' }],
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

  it('orders rootElements as [process, ...errors, ...escalations]', () => {
    const types = defs.rootElements.map((r) => r.$type);
    expect(types).toEqual(['bpmn:Process', 'bpmn:Error', 'bpmn:Escalation']);
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

  it('emits the escalation intermediate throw wired into the chain with incoming/outgoing', () => {
    const emit = requireDeep(defs, 'Emit1');
    expect(emit.$type).toBe('bpmn:IntermediateThrowEvent');
    expect((emit.incoming ?? []).map((f) => f.id)).toEqual([
      'SF_OuterSub_Emit1',
    ]);
    expect((emit.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Emit1_ThrowPF',
    ]);
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

  it('shares one root across two handlers and a throw of the same code', async () => {
    const handler = (id: string): FlowElement =>
      triggeredSub(id, [
        typedEvent('startEvent', `${id}_S`, errorDef('DUP')),
        { kind: 'endEvent', id: `${id}_E` },
      ]);
    const sharedIr: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'T', errorDef('DUP')),
        handler('H1'),
        handler('H2'),
      ],
      [{ id: 'SF_S_T', sourceRef: 'S', targetRef: 'T' }],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(sharedIr));
    const errors = rootsOfType(d, 'bpmn:Error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('Error_DUP');
  });

  /** The one `bpmn:Error` root of `S -> [occupied ->] T`, where T throws `def`. */
  const soleErrorRoot = async (
    def: EventDefinition,
    occupied?: string,
  ): Promise<Moddle> => {
    const thrown = typedEvent('endEvent', 'T', def);
    const ir =
      occupied === undefined
        ? minimalProcess(
            [{ kind: 'startEvent', id: 'S' }, thrown],
            [edge('S', 'T', { id: 'SF_S_T' })],
          )
        : minimalProcess(
            [
              { kind: 'startEvent', id: 'S' },
              { kind: 'userTask', id: occupied },
              thrown,
            ],
            [
              edge('S', occupied, { id: 'SF_S_X' }),
              edge(occupied, 'T', { id: 'SF_X_T' }),
            ],
          );
    const errors = rootsOfType(await defsOf(ir), 'bpmn:Error');
    expect(errors).toHaveLength(1);
    return errors[0]!;
  };

  it('sanitizes a root id from a code with non-id characters, keeping the code verbatim', async () => {
    const root = await soleErrorRoot(errorDef('NEEDS REVIEW!'));
    expect(root.id).toBe('Error_NEEDS_REVIEW_');
    expect(root.errorCode).toBe('NEEDS REVIEW!');
  });

  it('suffixes a root id that a flow element already holds', async () => {
    expect((await soleErrorRoot(errorDef('Boom'), 'Error_Boom')).id).toBe(
      'Error_Boom_2',
    );
  });

  it('lays event sub-processes out with children strictly inside their handler box', async () => {
    const xml = await irToXml(eventIr);
    // Exactly one diagram: the layout-generated one replaces the stubs.
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
    const shapes = await parseDiShapesById(xml);

    expectInside(shapes, 'EscHandler', ['EscStart', 'Notify', 'EscEnd']);
    expectInside(shapes, 'OuterSub', ['ErrHandler']);
    expectInside(shapes, 'ErrHandler', ['ErrStart', 'Recover', 'ErrEnd']);
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

  it.each([
    [
      'a class binding',
      classBinding('com.example.Send'),
      ['operaton:class="com.example.Send"'],
    ],
    [
      'an external binding',
      externalBinding('send-ack'),
      ['operaton:type="external"', 'operaton:topic="send-ack"'],
    ],
  ] as const)(
    'writes %s on a thrown message onto the definition, where the engine reads it',
    async (_title, binding, expected) => {
      const xml = await irToXml(
        minimalProcess(
          [
            { kind: 'startEvent', id: 'S' },
            { ...typedEvent('endEvent', 'Sent', messageDef('Ack')), binding },
          ],
          [{ id: 'F', sourceRef: 'S', targetRef: 'Sent' }],
        ),
      );
      const definition = /<bpmn:messageEventDefinition [^>]*>/.exec(xml)![0];
      for (const attribute of expected) {
        expect(definition).toContain(attribute);
      }
      // The engine ignores the same setting written on the event itself.
      expect(/<bpmn:endEvent [^>]*>/.exec(xml)![0]).not.toContain('operaton:');
    },
  );

  it('writes an emitted message implementation onto its definition too', async () => {
    const xml = await irToXml(
      around({
        ...typedEvent('intermediateThrowEvent', 'Ping', messageDef('Ack')),
        binding: delegateBinding('${senderBean}'),
      }),
    );
    expect(/<bpmn:messageEventDefinition [^>]*>/.exec(xml)![0]).toContain(
      'operaton:delegateExpression="${senderBean}"',
    );
  });

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
    // All three resolve to the single shared root.
    expect(handlerStart.signalRef?.id).toBe('Signal_Cancelled');
    expect(emit.signalRef?.id).toBe('Signal_Cancelled');
    expect(throwEnd.signalRef?.id).toBe('Signal_Cancelled');
    // The handler is an `alongside` one, so its start does not interrupt.
    expect(requireDeep(defs, 'SigStart').isInterrupting).toBe(false);
  });

  it('orders rootElements as [process, ...messages, ...signals] with no error/escalation roots', () => {
    const types = defs.rootElements.map((r) => r.$type);
    expect(types).toEqual(['bpmn:Process', 'bpmn:Message', 'bpmn:Signal']);
  });

  it('lays the message and signal handler bodies out inside their handler boxes', async () => {
    const xml = await irToXml(signalIr);
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
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

  it('emits one FormalExpression child per timer kind with the verbatim body, and no roots', async () => {
    const timerIr: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'endEvent', id: 'PEnd' },
        eventHandler('AfterH', 'AfterStart', timerDef('duration', 'PT1H')),
        eventHandler('AtH', 'AtStart', timerDef('date', '${dueDate}')),
        eventHandler('EveryH', 'EveryStart', timerDef('cycle', 'R/PT10M')),
        eventHandler('CondH', 'CondStart', conditionDef('${amount > 100}')),
      ],
      [{ id: 'SF_PStart_PEnd', sourceRef: 'PStart', targetRef: 'PEnd' }],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(timerIr));

    const after = soleDef(requireDeep(d, 'AfterStart'));
    expect(after.$type).toBe('bpmn:TimerEventDefinition');
    expect(after.timeDuration?.body).toBe('PT1H');
    expect(after.timeDate).toBeUndefined();
    expect(after.timeCycle).toBeUndefined();

    const at = soleDef(requireDeep(d, 'AtStart'));
    expect(at.timeDate?.body).toBe('${dueDate}');
    expect(at.timeDuration).toBeUndefined();

    const every = soleDef(requireDeep(d, 'EveryStart'));
    expect(every.timeCycle?.body).toBe('R/PT10M');
    expect(every.timeDuration).toBeUndefined();

    const cond = soleDef(requireDeep(d, 'CondStart'));
    expect(cond.$type).toBe('bpmn:ConditionalEventDefinition');
    expect(cond.condition?.body).toBe('${amount > 100}');

    // Timer and conditional contribute nothing at bpmn:Definitions level.
    expect(d.rootElements.map((r) => r.$type)).toEqual(['bpmn:Process']);
  });

  it('orders mixed roots [process, ...errors, ...escalations, ...messages, ...signals] and sanitizes the message name', async () => {
    const mixedIr: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('intermediateThrowEvent', 'EmitEsc', escalationDef('LS')),
        typedEvent('intermediateThrowEvent', 'EmitSig', signalDef('Cancelled')),
        typedEvent('endEvent', 'ThrowErr', errorDef('PF')),
        eventHandler('MsgHandler', 'MsgStart', messageDef('Order received!')),
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
    const message = rootsOfType(d, 'bpmn:Message')[0]!;
    expect(message.id).toBe('Message_Order_received_');
    // The name is the DSL string verbatim (unsanitized).
    expect(message.name).toBe('Order received!');
  });

  it('suffixes a synthesized signal root id that collides with an existing element id', async () => {
    // A user task literally named `Signal_Ping` occupies that id, so the root
    // for signal `Ping` must move to `Signal_Ping_2`.
    const d = await defsOf(
      chained([
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Signal_Ping' },
        typedEvent('intermediateThrowEvent', 'Emit', signalDef('Ping')),
        { kind: 'endEvent', id: 'E' },
      ]),
    );
    const signals = rootsOfType(d, 'bpmn:Signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('Signal_Ping_2');
    expect(signals[0]!.name).toBe('Ping');
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

  it('emits the handler start with a bare CompensateEventDefinition and no isInterrupting attribute', () => {
    // Raw-XML assertion rather than the parsed moddle object: bpmn-moddle
    // applies the schema default when reading `waitForCompletion` and
    // `isInterrupting` back, so the parsed tree shows `true` either way.
    const startBlock = extractNodeBlock(xml, 'CompStart');
    expect(startBlock).not.toContain('isInterrupting');
    expect(startBlock).toContain('<bpmn:compensateEventDefinition />');
    expect(startBlock).not.toContain('waitForCompletion');
    expect(startBlock).not.toContain('activityRef');
  });

  it('carries exactly one compensate definition on the intermediate throw and the end event', () => {
    expect(soleDef(requireDeep(defs, 'EmitComp')).$type).toBe(
      'bpmn:CompensateEventDefinition',
    );
    expect(soleDef(requireDeep(defs, 'ThrowComp')).$type).toBe(
      'bpmn:CompensateEventDefinition',
    );
  });

  it('synthesizes zero roots: rootElements contains only the process', () => {
    expect(defs.rootElements.map((r) => r.$type)).toEqual(['bpmn:Process']);
  });

  it('adds an error handler alongside compensation: one bpmn:Error root, still nothing for compensation, order unchanged', async () => {
    const mixedIr: BpmnProcess = {
      ...compensationIr,
      flowElements: [
        ...compensationIr.flowElements,
        eventHandler('ErrHandler', 'ErrStart', errorDef('PF')),
      ],
    };
    const d = await parseDefinitionsWithOperaton(await irToXml(mixedIr));
    expect(d.rootElements.map((r) => r.$type)).toEqual([
      'bpmn:Process',
      'bpmn:Error',
    ]);
    expect(rootsOfType(d, 'bpmn:Error')).toHaveLength(1);
  });

  it('lays the compensation handler out inside its host sub-process, children inside the handler', async () => {
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
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
  it('emits a bpmn:BoundaryEvent attached to its host with no cancelActivity attribute when interrupting', async () => {
    const xml = await irToXml(hostedBoundaryIr(messageDef('Ping')));
    const defs = await parseDefinitionsWithOperaton(xml);
    const boundary = requireDeep(defs, 'Boundary_Host_x');
    expect(boundary.$type).toBe('bpmn:BoundaryEvent');
    expect(boundary.attachedToRef?.id).toBe('Host');
    // Raw-XML assertion: bpmn-moddle applies the schema default for
    // `cancelActivity` when reading the attribute back, so a parsed check
    // cannot distinguish "absent" from "explicitly true".
    expect(extractNodeBlock(xml, 'Boundary_Host_x')).not.toContain(
      'cancelActivity',
    );
    // A boundary event carries no humanized name: its id is synthesized, so a
    // derived label would be noise in the diagram and churn in the goldens.
    expect(boundary.name).toBeUndefined();
    // It is reached by being attached, never by a flow.
    expect(boundary.incoming ?? []).toHaveLength(0);
    expect((boundary.outgoing ?? []).map((flow) => flow.id)).toEqual([
      'SF_Boundary_BoundaryEnd',
    ]);
  });

  it('emits cancelActivity="false" for a non-interrupting (alongside) boundary', async () => {
    const xml = await irToXml(hostedBoundaryIr(messageDef('Ping'), false));
    const defs = await parseDefinitionsWithOperaton(xml);
    expect(requireDeep(defs, 'Boundary_Host_x').cancelActivity).toBe(false);
    expect(extractNodeBlock(xml, 'Boundary_Host_x')).toContain(
      'cancelActivity="false"',
    );
  });

  it.each<[string, EventDefinition, string]>([
    ['error', errorDef('PF'), 'bpmn:ErrorEventDefinition'],
    ['escalation', escalationDef('LS'), 'bpmn:EscalationEventDefinition'],
    ['message', messageDef('Ping'), 'bpmn:MessageEventDefinition'],
    ['signal', signalDef('Cancelled'), 'bpmn:SignalEventDefinition'],
    ['timer', timerDef('duration', 'PT1H'), 'bpmn:TimerEventDefinition'],
    [
      'conditional',
      conditionDef('${amount > 100}'),
      'bpmn:ConditionalEventDefinition',
    ],
  ])(
    'carries the %s event definition child',
    async (_label, def, expectedType) => {
      const defs = await defsOf(hostedBoundaryIr(def));
      expect(soleDef(requireDeep(defs, 'Boundary_Host_x')).$type).toBe(
        expectedType,
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

  it('serializes a boundary event on a sub-process host with exactly one bpmndi:BPMNDiagram', async () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        chainedSub('HostSub', [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'SubWork' },
          { kind: 'endEvent', id: 'SubEnd' },
        ]),
        { kind: 'endEvent', id: 'PEnd' },
        boundaryEvent(
          'Boundary_HostSub_escalation',
          'HostSub',
          escalationDef('LS'),
        ),
        { kind: 'endEvent', id: 'EscEnd' },
      ],
      [
        { id: 'SF_PStart_HostSub', sourceRef: 'PStart', targetRef: 'HostSub' },
        { id: 'SF_HostSub_PEnd', sourceRef: 'HostSub', targetRef: 'PEnd' },
        edge('Boundary_HostSub_escalation', 'EscEnd', {
          id: 'SF_Boundary_EscEnd',
        }),
      ],
    );
    const xml = await irToXml(ir);
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
    const defs = await parseDefinitionsWithOperaton(xml);
    const boundary = requireDeep(defs, 'Boundary_HostSub_escalation');
    expect(boundary.attachedToRef?.id).toBe('HostSub');
  });

  // The second host id does exist in the document, just not where a boundary
  // event may reach it, so the message names the container rule: a bare
  // "unknown id" would send a reader looking for a missing element.
  it.each([
    ['is nowhere in the document', ghostHostIr(), 'Ghost'],
    ['sits inside a sub-process', hostInSubProcessIr(), 'Host'],
  ])('refuses a boundary event whose host %s', async (_title, ir, host) => {
    await expect(irToXml(ir)).rejects.toThrow(
      `BoundaryEvent "Boundary_Host_x" is attached to "${host}", which is not a flow element of this container.`,
    );
  });

  it('shares one root across a message caught by a boundary event and by a host-less handler', async () => {
    const ir: BpmnProcess = processIr(
      'proc',
      [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Host' },
        { kind: 'endEvent', id: 'PEnd' },
        boundaryEvent('Boundary_Host_message', 'Host', messageDef('Shared')),
        { kind: 'endEvent', id: 'BoundaryEnd' },
        eventHandler('MsgHandler', 'MsgStart', messageDef('Shared')),
      ],
      [
        { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
        { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
        edge('Boundary_Host_message', 'BoundaryEnd', {
          id: 'SF_Boundary_BoundaryEnd',
        }),
      ],
    );
    const defs = await parseDefinitionsWithOperaton(await irToXml(ir));
    const messages = rootsOfType(defs, 'bpmn:Message');
    expect(messages).toHaveLength(1);
    expect(
      soleDef(requireDeep(defs, 'Boundary_Host_message')).messageRef?.id,
    ).toBe(messages[0]!.id);
    expect(soleDef(requireDeep(defs, 'MsgStart')).messageRef?.id).toBe(
      messages[0]!.id,
    );
  });
});

/** The event definitions an `intermediateCatchEvent` node may carry. */
type CatchEventDefinition = Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
>;

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
  it('emits a bpmn:IntermediateCatchEvent with a MessageEventDefinition referencing a derived Message root, wired with incoming and outgoing', async () => {
    const ir = mainFlowCatchIr(messageDef('Invoice Received'));
    const defs = await parseDefinitionsWithOperaton(await irToXml(ir));
    const catchNode = requireDeep(defs, 'Catch_x');
    expect(catchNode.$type).toBe('bpmn:IntermediateCatchEvent');

    const def = soleDef(catchNode);
    expect(def.$type).toBe('bpmn:MessageEventDefinition');

    const messages = rootsOfType(defs, 'bpmn:Message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('Message_Invoice_Received');
    expect(messages[0]!.name).toBe('Invoice Received');
    expect(def.messageRef?.id).toBe(messages[0]!.id);

    expect((catchNode.incoming ?? []).map((f) => f.id)).toEqual([
      'SF_PStart_Catch',
    ]);
    expect((catchNode.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Catch_PEnd',
    ]);
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

  it('stamps no name attribute on the catch element: the await surface carries no label slot', async () => {
    const defs = await defsOf(mainFlowCatchIr(messageDef('Ping')));
    expect(requireDeep(defs, 'Catch_x').name).toBeUndefined();
  });
});

/**
 * Parse a document with the Operaton extension registered and return one flow
 * node of its process, with the Operaton settings resolved as typed properties.
 */
async function engineNode(xmlStr: string, id: string): Promise<Moddle> {
  const proc = await parseProcessTreeWithOperaton(xmlStr);
  return childById(proc, id);
}

/** The flat engine settings spread over five node kinds, one carrying none. */
const engineSettingsIr: BpmnProcess = {
  id: 'engine-settings',
  isExecutable: true,
  versionTag: '1.4.2',
  flowElements: [
    { kind: 'startEvent', id: 'Start', asyncAfter: true, jobPriority: '50' },
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
      binding: classBinding('com.example.Auto'),
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

  /** One flow node of the engine-settings process, with its Operaton props. */
  const node = (id: string): Moddle => childById(engineProc, id);

  it('writes operaton:versionTag on the process alongside historyTimeToLive', () => {
    const openingTag = engineXml.match(/<bpmn:process[^>]*>/)?.[0] ?? '';
    expect(openingTag).toContain('operaton:versionTag="1.4.2"');
    expect(openingTag).toContain('operaton:historyTimeToLive="P30D"');
  });

  it('writes the async continuation settings the IR carries, and nothing else', () => {
    const start = extractNodeBlock(engineXml, 'Start');
    expect(start).toContain('operaton:asyncAfter="true"');
    expect(start).toContain('operaton:jobPriority="50"');
    // Omitted in the IR, so absent from the XML: the engine default applies.
    expect(start).not.toContain('operaton:asyncBefore');
    expect(start).not.toContain('operaton:exclusive');

    const review = extractNodeBlock(engineXml, 'Review');
    expect(review).toContain('operaton:asyncBefore="true"');
    expect(review).toContain('operaton:exclusive="false"');
    expect(review).not.toContain('operaton:asyncAfter');
  });

  it('writes every user-task assignment attribute under the operaton prefix', () => {
    const review = extractNodeBlock(engineXml, 'Review');
    expect(review).toContain('operaton:assignee="demo"');
    expect(review).toContain(
      'operaton:formKey="embedded:app:forms/review.html"',
    );
    expect(review).toContain('operaton:candidateUsers="ann,bob"');
    expect(review).toContain('operaton:candidateGroups="reviewers"');
    expect(review).toContain('operaton:followUpDate="2026-01-31T12:00:00"');
    expect(review).toContain('operaton:priority="75"');
    expect(review).toMatch(
      /operaton:dueDate="\$\{dateTime\(\)\.plusDays\(2\)\}"/,
    );
  });

  it('writes operaton:resultVariable on both the service task and the script task', () => {
    expect(extractNodeBlock(engineXml, 'Auto')).toContain(
      'operaton:resultVariable="outcome"',
    );
    expect(extractNodeBlock(engineXml, 'Calc')).toContain(
      'operaton:resultVariable="total"',
    );
    expect(node('Auto').resultVariable).toBe('outcome');
    expect(node('Calc').resultVariable).toBe('total');
  });

  it('emits the retry cycle as an extension element, never as an attribute', () => {
    expect(engineXml).toMatch(
      /<operaton:failedJobRetryTimeCycle>\s*R3\/PT10M\s*<\/operaton:failedJobRetryTimeCycle>/,
    );
    expect(engineXml).not.toMatch(/failedJobRetryTimeCycle="/);
    expect(node('Calc').extensionElements?.values).toEqual([
      expect.objectContaining({
        $type: 'operaton:FailedJobRetryTimeCycle',
        body: 'R3/PT10M',
      }),
    ]);
  });

  it("keeps a user task's form data and its retry cycle under one wrapper", () => {
    expect(
      node('Review').extensionElements?.values.map((v) => v.$type),
    ).toEqual(['operaton:FormData', 'operaton:FailedJobRetryTimeCycle']);
  });

  it('emits no extensionElements wrapper for a node that contributes no children', () => {
    expect(node('End').extensionElements).toBeUndefined();
    expect(node('Start').extensionElements).toBeUndefined();
    expect(node('Auto').extensionElements).toBeUndefined();
    // Exactly two wrappers in the whole document: the user task and the script
    // task. Every other node contributes nothing and so opens none.
    expect(engineXml.match(/<bpmn:extensionElements/g)).toHaveLength(2);
  });

  it("keeps a call activity's mappings and its retry cycle under one wrapper", async () => {
    const callXml = await irToXml(
      minimalCallIr({
        kind: 'callActivity',
        id: 'CallSub',
        calledElement: 'sub-process',
        businessKey: '${execution.processBusinessKey}',
        inMappings: [{ kind: 'variable', source: 'amount', target: 'amount' }],
        outMappings: [{ kind: 'all' }],
        retryCycle: 'R5/PT1M',
      }),
    );
    const call = await engineNode(callXml, 'CallSub');
    expect(call.extensionElements?.values.map((v) => v.$type)).toEqual([
      'operaton:In',
      'operaton:In',
      'operaton:Out',
      'operaton:FailedJobRetryTimeCycle',
    ]);
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
    expect(extractNodeBlock(nestedXml, 'Sub')).toContain(
      'operaton:asyncBefore="true"',
    );
    expect(nestedXml).toMatch(
      /<operaton:failedJobRetryTimeCycle>\s*R2\/PT30S\s*<\/operaton:failedJobRetryTimeCycle>/,
    );
    expect(extractNodeBlock(nestedXml, 'Boundary_Sub_timer')).toContain(
      'operaton:asyncAfter="true"',
    );
  });

  it('writes neither attribute nor extension child for engine fields cast onto a gateway', async () => {
    // The IR keeps engine fields off both gateway kinds, so no honest fixture
    // can reach the runtime guard that skips them. The cast supplies the shape
    // the type forbids, which is the only way to observe the guard working.
    const gatewayXml = await irToXml(
      minimalProcess(
        [
          { kind: 'startEvent', id: 'S' },
          {
            kind: 'exclusiveGateway',
            id: 'G',
            asyncBefore: true,
            asyncAfter: true,
            exclusive: false,
            jobPriority: '30',
            retryCycle: 'R3/PT1M',
            executionListeners: [
              { event: 'start', binding: { kind: 'class', className: 'x.L' } },
            ],
          } as unknown as FlowElement,
          { kind: 'endEvent', id: 'E' },
        ],
        [
          { id: 'F1', sourceRef: 'S', targetRef: 'G' },
          { id: 'F2', sourceRef: 'G', targetRef: 'E' },
        ],
      ),
    );

    const block = extractNodeBlock(gatewayXml, 'G');
    expect(block).not.toContain('operaton:');
    expect(block).not.toContain('extensionElements');
  });
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

    // A text value is body text and no child element.
    expect(parameterContent(nestedGroupsBlock, 'plain').trim()).toBe('hello');

    // A script value is an operaton:script child carrying its format.
    expect(parameterContent(nestedGroupsBlock, 'scripted')).toMatch(
      /^\s*<operaton:script scriptFormat="groovy">\s*a \+ b\s*<\/operaton:script>\s*$/,
    );

    // A list of a text and a map, with a list nested inside that map.
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

    // A map value is operaton:entry children keyed by their IR key.
    expect(parameterContent(nestedGroupsBlock, 'result')).toMatch(
      /^\s*<operaton:map>\s*<operaton:entry key="code">\s*200\s*<\/operaton:entry>\s*<\/operaton:map>\s*$/,
    );
  });
});

describe('irToXml: listeners', () => {
  it('writes every binding form with its attributes unprefixed on the namespaced element', () => {
    // The element itself is `operaton:`-qualified, so its own attributes carry
    // no prefix. A prefixed one here parses as a foreign attribute the engine
    // ignores, which is why this asserts on the serialized text.
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
      /<operaton:taskListener event="timeout" delegateExpression="\$\{escalate\}"\s*>/,
    );
    expect(nestedGroupsBlock).toMatch(
      /<operaton:executionListener event="end">\s*<operaton:script scriptFormat="javascript">\s*log\(1\);\s*<\/operaton:script>\s*<\/operaton:executionListener>/,
    );

    // A timeout task listener also carries its timer as a bpmn child.
    expect(nestedGroupsBlock).toMatch(
      /<operaton:taskListener event="timeout"[^>]*>\s*<bpmn:timerEventDefinition>\s*<bpmn:timeDuration[^>]*>\s*PT2H\s*<\/bpmn:timeDuration>\s*<\/bpmn:timerEventDefinition>\s*<\/operaton:taskListener>/,
    );
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

/** One of each new kind, wired `Start -> Step -> Wait -> Notify -> Rate -> End`. */
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

  it('points a receive task at the bpmn:Message root synthesized from its name', () => {
    const messages = rootsOfType(defs, 'bpmn:Message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.name).toBe('OrderPaid');
    const wait = requireDeep(defs, 'Wait');
    expect(wait.$type).toBe('bpmn:ReceiveTask');
    expect(wait.messageRef?.id).toBe('Message_OrderPaid');
  });

  it.each([
    ['send', '<bpmn:sendTask'],
    ['businessRule', '<bpmn:businessRuleTask'],
  ] as const)(
    'writes a %s task under its own tag, binding code the way a service task does',
    async (element, tag) => {
      const xml = await irToXml(
        around({
          kind: 'serviceTask',
          id: 'T',
          element,
          binding: classBinding('com.example.Run'),
        }),
      );
      const block = extractNodeBlock(xml, 'T');
      expect(block).toContain(tag);
      expect(block).toContain('operaton:class="com.example.Run"');
    },
  );

  it('emits a decision binding as four DMN attributes on a bpmn:businessRuleTask', () => {
    const rate = extractNodeBlock(taskKindsXml, 'Rate');
    expect(rate).toContain('<bpmn:businessRuleTask');
    expect(rate).toContain('operaton:decisionRef="riskRating"');
    expect(rate).toContain('operaton:decisionRefBinding="version"');
    expect(rate).toContain('operaton:decisionRefVersion="3"');
    expect(rate).toContain('operaton:mapDecisionResult="singleEntry"');
    expect(rate).toContain('operaton:resultVariable="risk"');
  });

  it('re-reads through the Operaton descriptor with no moddle warnings', async () => {
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
    const node = extractNodeBlock(repeatedXml, id);
    expect(node).toContain(tag);
    expect(node).toContain('<bpmn:multiInstanceLoopCharacteristics');
  });

  it('re-reads through the Operaton descriptor with no moddle warnings', async () => {
    await expectNoModdleWarnings(repeatedXml);
  });

  it('writes a collection and its element variable, and no isSequential', async () => {
    const xml = await irToXml(
      around({ kind: 'userTask', id: 'Approve', loop: OVER_LINES }),
    );
    const node = extractNodeBlock(xml, 'Approve');
    expect(node).toContain('operaton:collection="lines"');
    expect(node).toContain('operaton:elementVariable="line"');
    expect(node).not.toContain('isSequential');
  });

  it('writes isSequential only for a sequential loop', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Approve',
        loop: { ...OVER_LINES, sequential: true },
      }),
    );
    expect(extractNodeBlock(xml, 'Approve')).toContain('isSequential="true"');
  });

  it.each([['3'], ['${n}']])(
    'writes the cardinality %s as the loopCardinality body',
    async (cardinality) => {
      const xml = await irToXml(
        around({ kind: 'userTask', id: 'Approve', loop: { cardinality } }),
      );
      expect(extractNodeBlock(xml, 'Approve')).toMatch(
        new RegExp(
          `<bpmn:loopCardinality[^>]*>${cardinality.replace(/[${}]/g, '\\$&')}</bpmn:loopCardinality>`,
        ),
      );
    },
  );

  it('writes no loop child when neither a count nor a collection is set', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Approve',
        loop: { sequential: true, completionCondition: '${done}' },
      }),
    );
    expect(extractNodeBlock(xml, 'Approve')).not.toContain(
      'multiInstanceLoopCharacteristics',
    );
  });

  it('writes the completion condition body verbatim', async () => {
    const xml = await irToXml(
      around({
        kind: 'userTask',
        id: 'Approve',
        loop: {
          ...OVER_LINES,
          completionCondition: '${nrOfCompletedInstances >= 2}',
        },
      }),
    );
    const decoded = extractNodeBlock(xml, 'Approve').replace(
      /(&#62;|&gt;)/g,
      '>',
    );
    expect(decoded).toMatch(
      /<bpmn:completionCondition[^>]*>\$\{nrOfCompletedInstances >= 2\}<\/bpmn:completionCondition>/,
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

  it('writes the block under bpmn:transaction and a plain one under bpmn:subProcess, children alike', async () => {
    const transaction = childById(await parseProcessTree(giveUpXml), 'Book');
    const plain = childById(
      await parseProcessTree(await irToXml(giveUpIr())),
      'Book',
    );
    expect(transaction.$type).toBe('bpmn:Transaction');
    expect(plain.$type).toBe('bpmn:SubProcess');
    expect(giveUpXml).toContain('<bpmn:transaction id="Book"');

    expect(structureOf(transaction)).toEqual(structureOf(plain));
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

  it('re-reads through the Operaton descriptor with no moddle warnings', async () => {
    await expectNoModdleWarnings(giveUpXml);
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
    const node = extractNodeBlock(await irToXml(repeated), 'Book');
    expect(node).toContain('<bpmn:transaction');
    expect(node).toContain('operaton:asyncBefore="true"');
    expect(node).toContain('<operaton:inputOutput>');
    expect(node).toContain('<bpmn:multiInstanceLoopCharacteristics');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Re-read a document with the Operaton extension registered and assert it came
 * back clean. Registering the extension is the stricter read: an `operaton:`
 * name the descriptor does not declare warns instead of falling into `$attrs`.
 */
async function expectNoModdleWarnings(xmlStr: string): Promise<void> {
  const { warnings } = await operatonModdle().fromXML(xmlStr);
  expect(warnings).toEqual([]);
}

/** Every attribute an `operaton:in`/`operaton:out` mapping can carry, if set. */
function mappingAttrs(mapping: Moddle): Record<string, unknown> {
  const keys = [
    'businessKey',
    'variables',
    'source',
    'sourceExpression',
    'target',
    'local',
  ] as const;
  return Object.fromEntries(
    keys.filter((k) => mapping[k] !== undefined).map((k) => [k, mapping[k]]),
  );
}

/** A container's children as `<type> <id>`, in document order. */
function structureOf(container: Moddle): string[] {
  return (container.flowElements ?? []).map((e) => `${e.$type} ${e.id}`);
}

/** The `<bpmn:incoming>`/`<bpmn:outgoing>` child count of one flow node. */
function degreeOf(xmlStr: string, id: string): { in: number; out: number } {
  const block = extractNodeBlock(xmlStr, id);
  return {
    in: (block.match(/<bpmn:incoming>/g) ?? []).length,
    out: (block.match(/<bpmn:outgoing>/g) ?? []).length,
  };
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

/**
 * Parse a BPMN XML string with the Operaton extension registered and return the
 * `bpmn:Definitions` root, so both the semantic tree (`rootElements`, nested
 * `flowElements`) and the Operaton-namespaced event attributes resolve to typed
 * properties.
 */
async function parseDefinitionsWithOperaton(xmlStr: string): Promise<Moddle> {
  const { rootElement } = await operatonModdle().fromXML(xmlStr);
  return rootElement;
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

/** The Operaton moddle extension descriptor, read from source (as `irToXml` does). */
const OPERATON_EXTENSION: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(here, '../src/operaton-moddle.json'), 'utf-8'),
);

/** A raw `BpmnModdle` carrying the Operaton extension, for reading operaton:* nodes. */
function operatonModdle(): InstanceType<typeof BpmnModdle> {
  return new BpmnModdle({ operaton: OPERATON_EXTENSION });
}

/**
 * Like {@link parseProcessTree}, but with the Operaton extension registered so
 * `operaton:in`/`operaton:out` children and `operaton:calledElement*`
 * attributes resolve to typed properties rather than raw XML.
 */
async function parseProcessTreeWithOperaton(xmlStr: string): Promise<Moddle> {
  const { rootElement } = await operatonModdle().fromXML(xmlStr);
  return processOf(rootElement);
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

/**
 * Parse a BPMN XML string's `bpmndi:BPMNDiagram` and return every
 * `bpmndi:BPMNShape` it contains, keyed by the id of the BPMN element it
 * represents (`shape.bpmnElement`). Used to assert on the generated layout,
 * unlike {@link parseProcessTree}, which inspects the semantic element tree.
 */
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
 * A parsed moddle node: the `bpmn:Definitions` root, a flow node, an event
 * definition, or an extension-element child. One façade over the untyped
 * moddle graph, so a test navigates references and reads Operaton-namespaced
 * settings as typed properties instead of casting at every hop.
 */
interface Moddle {
  $type: string;
  id?: string;
  name?: string;
  body?: string;
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
  cancelActivity?: boolean;
  triggeredByEvent?: boolean;
  versionTag?: string;
  asyncBefore?: boolean;
  asyncAfter?: boolean;
  exclusive?: boolean;
  jobPriority?: string;
  assignee?: string;
  formKey?: string;
  candidateUsers?: string;
  candidateGroups?: string;
  dueDate?: string;
  followUpDate?: string;
  priority?: string;
  resultVariable?: string;
  calledElement?: string;
  calledElementBinding?: string;
  calledElementVersion?: string;
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

/**
 * Parse a BPMN XML string with raw `bpmn-moddle` and return the root
 * `bpmn:Process` element as a navigable tree. Used to inspect the semantic
 * element structure (nesting, references) without asserting on DI shapes.
 */
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
 * The serialized text of one flow node, from its opening tag to its closing tag
 * or self-close, so a child count never picks up a sibling's. Found by scanning
 * for `id="<nodeId>"` and walking out to the tag boundaries, which holds for
 * the formatted output the writer produces.
 */
function extractNodeBlock(xml: string, nodeId: string): string {
  // Find the start of the tag that carries `id="<nodeId>"`.
  const idAttr = `id="${nodeId}"`;
  const idPos = xml.indexOf(idAttr);
  if (idPos === -1) {
    throw new Error(`Node id="${nodeId}" not found in XML output.`);
  }

  // Walk backwards to find the opening `<` of the tag.
  let tagStart = idPos;
  while (tagStart > 0 && xml[tagStart] !== '<') {
    tagStart--;
  }

  // Determine the element name (e.g. `bpmn:startEvent`).
  const tagNameMatch = xml.slice(tagStart + 1).match(/^([^\s/>]+)/);
  if (!tagNameMatch) {
    throw new Error(
      `Could not determine element name at position ${tagStart}.`,
    );
  }
  const tagName = tagNameMatch[1]!;

  // Find the end of this element. The element is either self-closing (`/>`)
  // or has a closing tag (`</bpmn:foo>`).
  const selfClosePos = xml.indexOf('/>', tagStart);
  const closeTagStr = `</${tagName}>`;
  const closeTagPos = xml.indexOf(closeTagStr, tagStart);

  let blockEnd: number;
  if (
    selfClosePos !== -1 &&
    (closeTagPos === -1 || selfClosePos < closeTagPos)
  ) {
    blockEnd = selfClosePos + 2; // include `>`
  } else if (closeTagPos !== -1) {
    blockEnd = closeTagPos + closeTagStr.length;
  } else {
    throw new Error(
      `Could not find end of element "${tagName}" with id="${nodeId}".`,
    );
  }

  return xml.slice(tagStart, blockEnd);
}
