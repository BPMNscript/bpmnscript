/**
 * Integration-level tests: `irToXml` calls `bpmn-auto-layout`, which performs
 * real DOM layout, so each test exercises the full serializer.
 *
 * Two fixtures drive this suite. `importShapedIr` is a hand-authored IR
 * mirroring what `xmlToIr` produces from the handwritten golden, so its ids are
 * the imported ones and its gateway has no synthesized join. It drives the
 * unit-level checks without depending on the parser or the desugarer. The
 * full-pipeline block instead runs `irToXml(astToIr(parse(...)))` over the
 * example process and byte-compares against the generated golden, where the
 * gateway ids are synthesized and the `if`/`else` desugars to a split + join
 * pair.
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

/**
 * Import-shaped IR mirroring what `xmlToIr` produces from
 * `tests/golden/invoice-approval-handwritten.bpmn`, with the handwritten ids
 * preserved verbatim on import.
 *
 * The start event (ReviewStart) and end event (Done) have no `name` because the
 * handwritten BPMN gives them no `name` attribute, and the gateway has no
 * synthesized join: both branches converge directly on `Done`, exactly as the
 * handwritten import does.
 */
const importShapedIr: BpmnProcess = {
  ...HANDWRITTEN_IMPORT_IR,
  name: 'Invoice Approval',
};

// ── Shared XML output ────────────────────────────────────────────────────────

let xml: string;

beforeAll(async () => {
  xml = await irToXml(importShapedIr);
});

// ── 1. Parses cleanly via bpmn-moddle ────────────────────────────────────────

describe('irToXml — bpmn-moddle round-trip', () => {
  it('irToXml(importShapedIr) parses cleanly via bpmn-moddle.fromXML', async () => {
    const moddle = new BpmnModdle({});
    const { warnings } = await moddle.fromXML(xml);
    expect(warnings).toEqual([]);
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

// ── 2. Expected Operaton attributes ──────────────────────────────────────────

describe('irToXml — Operaton extension attributes', () => {
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

// ── 3. Per-node incoming/outgoing count ──────────────────────────────────────

describe('irToXml — per-node incoming/outgoing graph degree', () => {
  /**
   * Parse the XML into a moddle graph and verify incoming/outgoing counts
   * for every flow node, matching the edges defined in the canonical IR, a
   * per-node check rather than just aggregate totals.
   *
   * Expected degrees for the invoice-approval graph:
   *   ReviewStart:    in=0,  out=1  (start event)
   *   ReviewInvoice:  in=1,  out=1
   *   AmountCheck:    in=1,  out=2  (gateway: 2 outgoing branches)
   *   SeniorApproval: in=1,  out=1
   *   AutoApprove:    in=1,  out=1
   *   Done:           in=2,  out=0  (end event)
   */

  interface NodeDegree {
    in: number;
    out: number;
  }
  const EXPECTED_DEGREES: Record<string, NodeDegree> = {
    ReviewStart: { in: 0, out: 1 },
    ReviewInvoice: { in: 1, out: 1 },
    AmountCheck: { in: 1, out: 2 },
    SeniorApproval: { in: 1, out: 1 },
    AutoApprove: { in: 1, out: 1 },
    Done: { in: 2, out: 0 },
  };

  for (const [nodeId, expected] of Object.entries(EXPECTED_DEGREES)) {
    it(`${nodeId}: incoming=${expected.in}, outgoing=${expected.out}`, () => {
      // Count <bpmn:incoming> children by scanning the XML block for the
      // element's id and then its immediate children.
      const nodeBlock = extractNodeBlock(xml, nodeId);
      const incomingCount = (nodeBlock.match(/<bpmn:incoming>/g) ?? []).length;
      const outgoingCount = (nodeBlock.match(/<bpmn:outgoing>/g) ?? []).length;

      expect(incomingCount).toBe(expected.in);
      expect(outgoingCount).toBe(expected.out);
    });
  }
});

// ── 4. Full-pipeline golden diff ─────────────────────────────────────────────

describe('irToXml — full-pipeline golden diff', () => {
  /**
   * Pins the whole pipeline: parse(example.bpmnscript) -> astToIr -> irToXml
   * must equal `tests/golden/invoice-approval-generated.bpmn` byte-for-byte.
   * That golden is what the engine E2E deploys, so the synthesized gateway and
   * flow ids are pinned here alongside the engine-contract values (process id,
   * userTask ids, `operaton:class`, `operaton:assignee`, the condition body).
   */
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
    // The example process holds no sub-process, so this also pins that the DI
    // expansion hint is attached only when one is actually present.
    const goldenXml = readFileSync(GOLDEN_GENERATED_PATH, 'utf-8');
    expect(pipelineXml).toBe(goldenXml);
  });

  it('preserves the engine contract (process id, task ids, delegate, assignees, condition)', () => {
    expect(pipelineXml).toContain('<bpmn:process id="invoice-approval"');
    expect(pipelineXml).toContain('id="ReviewInvoice"');
    expect(pipelineXml).toContain('id="SeniorApproval"');
    expect(pipelineXml).toContain(
      'operaton:class="com.example.invoice.AutoApproveDelegate"',
    );
    expect(pipelineXml).toContain('operaton:assignee="demo"');
    expect(pipelineXml).toContain('operaton:assignee="manager"');
    expect(pipelineXml).toContain('${amount &gt; 1000}');
  });
});

// ── 5. Parallel gateway serialization ────────────────────────────────────────

describe('irToXml — parallelGateway serialization', () => {
  /**
   * A minimal parallel split+join IR:
   *   Start -> Fork (parallelGateway, 2 outgoing)
   *     -> BranchA (userTask)
   *     -> BranchB (userTask)
   *   BranchA, BranchB -> Join (parallelGateway, 2 incoming)
   *   Join -> End
   */
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

  it('emits Fork and Join as bpmn:parallelGateway with their split/join degrees', () => {
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Fork"/);
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Join"/);
    const forkBlock = extractNodeBlock(parallelXml, 'Fork');
    const joinBlock = extractNodeBlock(parallelXml, 'Join');
    expect((forkBlock.match(/<bpmn:incoming>/g) ?? []).length).toBe(1);
    expect((forkBlock.match(/<bpmn:outgoing>/g) ?? []).length).toBe(2);
    expect((joinBlock.match(/<bpmn:incoming>/g) ?? []).length).toBe(2);
    expect((joinBlock.match(/<bpmn:outgoing>/g) ?? []).length).toBe(1);
  });

  it('output does not contain a default attribute on any parallelGateway', () => {
    // Extract all parallelGateway blocks and check none have default=
    const forkBlock = extractNodeBlock(parallelXml, 'Fork');
    const joinBlock = extractNodeBlock(parallelXml, 'Join');
    expect(forkBlock).not.toContain('default=');
    expect(joinBlock).not.toContain('default=');
  });
});

// ── 6. serviceTask binding variants ──────────────────────────────────────────

describe('irToXml — serviceTask binding variants', () => {
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

// ── 7. scriptTask serialization ──────────────────────────────────────────────

describe('irToXml — scriptTask serialization', () => {
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

  it('emits a bpmn:scriptTask element with scriptFormat="javascript"', () => {
    expect(scriptXml).toMatch(
      /<bpmn:scriptTask[^>]*id="Compute"[^>]*scriptFormat="javascript"/,
    );
  });

  it('the script body text survives inside the element', () => {
    expect(scriptXml).toContain('var total = amount * 2;');
    expect(scriptXml).toContain('return total;');
  });

  it('parses cleanly via bpmn-moddle', async () => {
    const moddle = new BpmnModdle({});
    const { warnings } = await moddle.fromXML(scriptXml);
    expect(warnings).toEqual([]);
  });
});

// ── 8. Sub-process containment ───────────────────────────────────────────────

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

describe('irToXml — sub-process containment', () => {
  /**
   * Process `PStart -> sub -> PEnd`, where `sub` is an embedded sub-process
   * whose own body is `SubStart -> Review -> SubEnd`. The semantic element tree
   * (not the DI, which auto-layout regenerates) is inspected by parsing the
   * output back with raw `bpmn-moddle`.
   */
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

  it('emits a bpmn:SubProcess holding its three children and two nested flows', () => {
    const sub = childById(proc, 'sub');
    expect(sub.$type).toBe('bpmn:SubProcess');
    const childTypes = (sub.flowElements ?? []).map((e) => e.$type);
    expect(childTypes).toContain('bpmn:StartEvent');
    expect(childTypes).toContain('bpmn:UserTask');
    expect(childTypes).toContain('bpmn:EndEvent');
    const nestedFlows = (sub.flowElements ?? []).filter(
      (e) => e.$type === 'bpmn:SequenceFlow',
    );
    expect(nestedFlows.map((f) => f.id).sort()).toEqual([
      'SF_Review_SubEnd',
      'SF_SubStart_Review',
    ]);
  });

  it('wires nested children incoming/outgoing to the nested flows', () => {
    const sub = childById(proc, 'sub');
    const review = childById(sub, 'Review');
    expect((review.incoming ?? []).map((f) => f.id)).toEqual([
      'SF_SubStart_Review',
    ]);
    expect((review.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Review_SubEnd',
    ]);
  });

  it('routes parent-level flows to the sub-process element and keeps nested flows nested', () => {
    const intoSub = childById(proc, 'SF_PStart_sub');
    expect(intoSub.targetRef?.id).toBe('sub');
    const outOfSub = childById(proc, 'SF_sub_PEnd');
    expect(outOfSub.sourceRef?.id).toBe('sub');

    const parentIds = (proc.flowElements ?? []).map((e) => e.id);
    expect(parentIds).toContain('sub');
    expect(parentIds).not.toContain('SubStart');
    expect(parentIds).not.toContain('SF_SubStart_Review');
  });

  it('parses cleanly via bpmn-moddle', async () => {
    const moddle = new BpmnModdle({});
    const { warnings } = await moddle.fromXML(nestedXml);
    expect(warnings).toEqual([]);
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

// ── 9. DI expansion hint for sub-processes ───────────────────────────────────

describe('irToXml — DI expansion hint for sub-processes', () => {
  /**
   * `bpmn-auto-layout` fed DI-less XML containing a `bpmn:subProcess` renders it
   * collapsed and scatters shapes for its children into the root plane. To avoid
   * that, `irToXml` pre-seeds a minimal `bpmndi:BPMNShape isExpanded="true"` per
   * sub-process before layout, so the library expands the parent box and lays
   * the children out inside it.
   */
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

  it('every nested child shape falls strictly inside its parent sub-process shape', async () => {
    const xml = await irToXml(twoChildrenIr);
    const shapes = await parseDiShapesById(xml);
    expectInside(shapes, 'sub', ['SubStart', 'ReviewA', 'ReviewB', 'SubEnd']);
  });

  it('two-level nesting: inner sub-process sits inside the outer, inner children inside the inner', async () => {
    const xml = await irToXml(twoLevelIr);
    const shapes = await parseDiShapesById(xml);
    expectInside(shapes, 'Outer', ['Inner']);
    expectInside(shapes, 'Inner', ['IStart', 'Deep', 'IEnd']);
  });

  it('emits exactly one bpmndi:BPMNDiagram (the layout-generated one replaces the stub)', async () => {
    const xml = await irToXml(twoChildrenIr);
    const diagramCount = (xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length;
    expect(diagramCount).toBe(1);
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

// ── 10. callActivity serialization ───────────────────────────────────────────

describe('irToXml — callActivity serialization', () => {
  /**
   * `start -> call -> end`, where the call activity populates every feature:
   * a label, a `deployment` binding, a business key, all three in-mapping
   * variants (one carrying `local`), and two out-mappings. Exercises the full
   * pipeline (layout included) and the canonical extension-element order.
   */
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

  it('emits a bpmn:CallActivity carrying calledElement and the deployment binding', () => {
    expect(call.$type).toBe('bpmn:CallActivity');
    expect(call.calledElement).toBe('sub-process');
    expect(call.calledElementBinding).toBe('deployment');
    // A non-version binding never emits a version attribute.
    expect(call.calledElementVersion).toBeUndefined();
  });

  it('emits extension-element children in canonical order with exact attributes', () => {
    const values = call.extensionElements?.values ?? [];
    // businessKey `in`, then 3 in-mappings, then 2 out-mappings.
    expect(values.map((v) => v.$type)).toEqual([
      'operaton:In',
      'operaton:In',
      'operaton:In',
      'operaton:In',
      'operaton:Out',
      'operaton:Out',
    ]);

    // (1) business key
    expect(values[0]).toMatchObject({
      businessKey: '${execution.processBusinessKey}',
    });
    // (2) in-mappings in IR order
    expect(values[1]).toMatchObject({ variables: 'all' });
    expect(values[2]).toMatchObject({ source: 'amount', target: 'amount' });
    expect(values[3]).toMatchObject({
      sourceExpression: '${total * 2}',
      target: 'doubled',
      local: true,
    });
    // (3) out-mappings in IR order
    expect(values[4]).toMatchObject({ source: 'result', target: 'outcome' });
    expect(values[5]).toMatchObject({
      sourceExpression: '${status}',
      target: 'final',
    });
  });

  it('serializes `local` only on the mapping where it is set', () => {
    const values = call.extensionElements?.values ?? [];
    // Only the expression in-mapping (index 3) carries local.
    expect(values[0]?.local).toBeUndefined();
    expect(values[1]?.local).toBeUndefined();
    expect(values[2]?.local).toBeUndefined();
    expect(values[3]?.local).toBe(true);
    expect(values[4]?.local).toBeUndefined();
    expect(values[5]?.local).toBeUndefined();
  });

  it('wires the call activity with incoming/outgoing like any activity', () => {
    // Assert on the parsed graph rather than the raw block: a call activity
    // with self-closing `operaton:in` children defeats the string-scanning
    // block extractor, but the wired references are unambiguous.
    expect((call.incoming ?? []).map((f) => f.id)).toEqual(['F_Start_Call']);
    expect((call.outgoing ?? []).map((f) => f.id)).toEqual(['F_Call_End']);
  });

  it('parses cleanly via bpmn-moddle carrying the extension', async () => {
    const { warnings } = await operatonModdle().fromXML(callXml);
    expect(warnings).toEqual([]);
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

  it('emits neither binding attribute when no binding is present', async () => {
    const ir = minimalCallIr(callActivity('CallSub', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub');
    expect(c.calledElementBinding).toBeUndefined();
    expect(c.calledElementVersion).toBeUndefined();
  });

  it('emits no extensionElements for a minimal call (calledElement only)', async () => {
    const ir = minimalCallIr(callActivity('CallSub', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub');
    expect(c.extensionElements).toBeUndefined();
  });

  it('derives a humanized name for an unnamed call activity', async () => {
    const ir = minimalCallIr(callActivity('ProcessPayment', 'sub'));
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'ProcessPayment');
    // The excluded-name path does not apply to activities: the id humanizes.
    expect(c.name).toBe('Process Payment');
  });

  it('keeps an explicit name verbatim', () => {
    expect(call.name).toBe('Call sub');
  });
});

// ── 11. Event layer: errors + escalations ────────────────────────────────────

describe('irToXml — event layer (errors + escalations)', () => {
  /**
   * A process exercising the whole event surface at once:
   *   - `errorMessages` declaring the message for code `PF`.
   *   - A normal sub-process `OuterSub` whose body is start/user/end, and which
   *     *contains* an interrupting error handler `ErrHandler` (event
   *     sub-process, code `PF`, both catch bindings).
   *   - An `alongside` escalation handler `EscHandler` at process level (code
   *     `LS`, one code binding).
   *   - A `throw error` end event `ThrowPF` (code `PF`) in the main chain.
   *   - An escalation intermediate throw `Emit1` (code `LS`) in the main chain.
   * Handlers are disconnected (no incoming/outgoing): event sub-processes are
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

  it('sanitizes a root id from a code with non-id characters', async () => {
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        typedEvent('endEvent', 'T', errorDef('NEEDS REVIEW!')),
      ],
      [{ id: 'SF_S_T', sourceRef: 'S', targetRef: 'T' }],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(ir));
    const errors = rootsOfType(d, 'bpmn:Error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('Error_NEEDS_REVIEW_');
    // The name is the code verbatim (unsanitized).
    expect(errors[0]!.errorCode).toBe('NEEDS REVIEW!');
  });

  it('suffixes a root id that would collide with an existing element id', async () => {
    // A user task literally named `Error_Boom` occupies that id, so the root
    // for code `Boom` must move to `Error_Boom_2`.
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Error_Boom' },
        typedEvent('endEvent', 'T', errorDef('Boom')),
      ],
      [
        { id: 'SF_S_X', sourceRef: 'S', targetRef: 'Error_Boom' },
        { id: 'SF_X_T', sourceRef: 'Error_Boom', targetRef: 'T' },
      ],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(ir));
    const errors = rootsOfType(d, 'bpmn:Error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('Error_Boom_2');
  });

  it('lays event sub-processes out with children strictly inside their handler box', async () => {
    const shapes = await parseDiShapesById(await irToXml(eventIr));
    // Exactly one diagram: the layout-generated one replaces the stubs.
    const xml = await irToXml(eventIr);
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);

    expectInside(shapes, 'EscHandler', ['EscStart', 'Notify', 'EscEnd']);
    expectInside(shapes, 'OuterSub', ['ErrHandler']);
    expectInside(shapes, 'ErrHandler', ['ErrStart', 'Recover', 'ErrEnd']);
  });
});

// ── 12. Event layer: message + signal + timer + conditional ──────────────────

describe('irToXml — event layer (message + signal + timer + conditional)', () => {
  /**
   * A process exercising message/signal handlers plus both signal throw forms:
   *   - An interrupting `on message "PaymentReceived"` handler.
   *   - An `alongside` `on signal "Cancelled"` handler.
   *   - An `emit signal "Cancelled"` intermediate throw mid-chain.
   *   - A `throw signal "Cancelled"` end event, sharing the one signal root.
   */
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
  });

  it('marks the alongside signal handler start non-interrupting', () => {
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
    const ir: BpmnProcess = minimalProcess(
      [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Signal_Ping' },
        typedEvent('intermediateThrowEvent', 'Emit', signalDef('Ping')),
        { kind: 'endEvent', id: 'E' },
      ],
      [
        { id: 'SF_S_X', sourceRef: 'S', targetRef: 'Signal_Ping' },
        { id: 'SF_X_Emit', sourceRef: 'Signal_Ping', targetRef: 'Emit' },
        { id: 'SF_Emit_E', sourceRef: 'Emit', targetRef: 'E' },
      ],
    );
    const d = await parseDefinitionsWithOperaton(await irToXml(ir));
    const signals = rootsOfType(d, 'bpmn:Signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('Signal_Ping_2');
    expect(signals[0]!.name).toBe('Ping');
  });
});

// ── 13. Event layer: compensation ────────────────────────────────────────────

describe('irToXml — event layer (compensation)', () => {
  /**
   * A process exercising the whole compensation surface at once:
   *   - `OuterSub`, a normal sub-process with an interior start/user/end chain,
   *     containing a compensation handler (`CompHandler`, an event
   *     sub-process whose start carries `{ kind: 'compensation' }`, no
   *     `isInterrupting`).
   *   - A compensation intermediate throw (`EmitComp`) mid-chain.
   *   - A compensation end event (`ThrowComp`) terminal in the parent process.
   * Compensation is payload-less, so none of these carry a code: unlike the
   * error/escalation fixture above, there is no identity to share a root over.
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

  it('synthesizes zero roots — rootElements contains only the process', () => {
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

// ── 14. Boundary events ───────────────────────────────────────────────────────

/**
 * A minimal process with one host activity carrying one boundary event:
 * `PStart -> Host -> PEnd` in the main flow, plus a `boundaryEvent` attached to
 * `Host` whose one outgoing flow lands on its own end event, the shape a
 * hosted handler with an empty body lowers to.
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

describe('irToXml — boundary events', () => {
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

  it('carries an outgoing sequence flow and no incoming', async () => {
    const defs = await defsOf(hostedBoundaryIr(messageDef('Ping')));
    const boundary = requireDeep(defs, 'Boundary_Host_x');
    expect(boundary.incoming ?? []).toHaveLength(0);
    expect((boundary.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Boundary_BoundaryEnd',
    ]);
  });

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
    const defs = await parseDefinitionsWithOperaton(await irToXml(ir));
    const errBoundary = requireDeep(defs, 'Boundary_Host_error');
    const timerBoundary = requireDeep(defs, 'Boundary_Host_timer');
    expect(errBoundary.$type).toBe('bpmn:BoundaryEvent');
    expect(timerBoundary.$type).toBe('bpmn:BoundaryEvent');
    expect(errBoundary.attachedToRef?.id).toBe('Host');
    expect(timerBoundary.attachedToRef?.id).toBe('Host');
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

  it('throws when a boundary event references an unknown host', async () => {
    const ir = hostedBoundaryIr(messageDef('Ping'));
    const broken: BpmnProcess = {
      ...ir,
      flowElements: ir.flowElements.map((el) =>
        el.kind === 'boundaryEvent' ? { ...el, attachedToRef: 'Ghost' } : el,
      ),
    };
    await expect(irToXml(broken)).rejects.toThrow(
      'BoundaryEvent "Boundary_Host_x" is attached to "Ghost", which is not a flow element of this container.',
    );
  });

  it('names the container rule when the host exists but sits inside a sub-process', async () => {
    // The id does exist in the document, just not where a boundary event may
    // reach it. A bare "unknown id" message would send a reader looking for a
    // missing element instead of a misplaced attachment.
    const nested: BpmnProcess = processIr(
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
    await expect(irToXml(nested)).rejects.toThrow(
      'BoundaryEvent "Boundary_Host_x" is attached to "Host", which is not a flow element of this container.',
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

// ── 15. Intermediate catch events ─────────────────────────────────────────────

/** The event definitions an `intermediateCatchEvent` node may carry. */
type CatchEventDefinition = Extract<
  EventDefinition,
  { kind: 'message' | 'signal' | 'timer' | 'conditional' }
>;

/**
 * A minimal process with an `intermediateCatchEvent` sitting inline on the
 * main flow: `PStart -> Catch -> PEnd`, the shape the desugarer produces for
 * `await`, with one incoming and one outgoing sequence flow.
 */
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

describe('irToXml — intermediate catch events', () => {
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
    [string, CatchEventDefinition, 'timeDuration' | 'timeDate' | 'timeCycle']
  >([
    ['duration', timerDef('duration', 'PT1H'), 'timeDuration'],
    ['date', timerDef('date', '${dueDate}'), 'timeDate'],
    ['cycle', timerDef('cycle', 'R/PT10M'), 'timeCycle'],
  ])(
    'emits a TimerEventDefinition with the matching %s child',
    async (_label, eventDefinition, child) => {
      const defs = await defsOf(mainFlowCatchIr(eventDefinition));
      const def = soleDef(requireDeep(defs, 'Catch_x'));
      expect(def.$type).toBe('bpmn:TimerEventDefinition');
      expect(eventDefinition.kind).toBe('timer');
      const expression =
        eventDefinition.kind === 'timer' ? eventDefinition.expression : '';
      expect(def[child]?.body).toBe(expression);

      const others = (
        ['timeDuration', 'timeDate', 'timeCycle'] as const
      ).filter((c) => c !== child);
      for (const other of others) {
        expect(def[other]).toBeUndefined();
      }
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

  it('stamps no name attribute on the catch element — the await surface carries no label slot', async () => {
    const defs = await defsOf(mainFlowCatchIr(messageDef('Ping')));
    expect(requireDeep(defs, 'Catch_x').name).toBeUndefined();
  });
});

// ── 16. Engine attributes and extension-element assembly ─────────────────────

/**
 * Parse a document with the Operaton extension registered and return one flow
 * node of its process, with the Operaton settings resolved as typed properties.
 */
async function engineNode(xmlStr: string, id: string): Promise<Moddle> {
  const proc = await parseProcessTreeWithOperaton(xmlStr);
  return childById(proc, id);
}

/**
 * `Start -> Review -> Auto -> Calc -> End`, spreading the flat engine settings
 * over five node kinds: an async-after start, a fully assigned user task
 * carrying both a form and a retry cycle, a service task with a result
 * variable, a script task with its own retry cycle, and an end event carrying
 * nothing at all.
 */
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

describe('irToXml — flat engine attributes', () => {
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

  it('keeps a user task’s form data and its retry cycle under one wrapper', () => {
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

  it('keeps a call activity’s mappings and its retry cycle under one wrapper', async () => {
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

// ── 17. Input/output parameters and listeners ────────────────────────────────

/**
 * One user task carrying every nested group at once: a form, input parameters
 * in all four value forms (with a map nested inside a list and a list nested
 * inside that map's entry), an output parameter, both execution-listener
 * events, three of the four listener bindings plus a `timeout` listener with
 * its timer, and a retry cycle. Written as a single fixture so the assembler's
 * emission order is observable on one wrapper.
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

describe('irToXml — input/output parameters', () => {
  let block: string;

  beforeAll(async () => {
    block = extensionBlock(await irToXml(nestedGroupsIr));
  });

  it('emits one operaton:inputOutput holding every value form, in IR order', () => {
    expect(block).toMatch(
      /<operaton:inputOutput>[\s\S]*<operaton:inputParameter[\s\S]*<operaton:outputParameter[\s\S]*<\/operaton:inputOutput>/,
    );
    expect(block.match(/<operaton:inputOutput\b/g)).toHaveLength(1);
    expect(
      [
        ...block.matchAll(/<operaton:(?:in|out)putParameter name="([^"]+)"/g),
      ].map((m) => m[1]),
    ).toEqual(['plain', 'scripted', 'nested', 'result']);

    // A text value is body text and no child element.
    expect(parameterContent(block, 'plain').trim()).toBe('hello');

    // A script value is an operaton:script child carrying its format.
    expect(parameterContent(block, 'scripted')).toMatch(
      /^\s*<operaton:script scriptFormat="groovy">\s*a \+ b\s*<\/operaton:script>\s*$/,
    );

    // A list of a text and a map, with a list nested inside that map.
    expect(parameterContent(block, 'nested')).toMatch(
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
    expect(parameterContent(block, 'result')).toMatch(
      /^\s*<operaton:map>\s*<operaton:entry key="code">\s*200\s*<\/operaton:entry>\s*<\/operaton:map>\s*$/,
    );
  });
});

describe('irToXml — listeners', () => {
  let block: string;

  beforeAll(async () => {
    block = extensionBlock(await irToXml(nestedGroupsIr));
  });

  it('writes every binding form with its attributes unprefixed on the namespaced element', () => {
    // The element itself is `operaton:`-qualified, so its own attributes carry
    // no prefix. A prefixed one here parses as a foreign attribute the engine
    // ignores, which is why this asserts on the serialized text.
    for (const listener of listenerTags(block)) {
      expect(listener).not.toMatch(/\soperaton:/);
    }
    expect(block).toMatch(
      /<operaton:executionListener event="start" class="com\.example\.Enter"\s*\/>/,
    );
    expect(block).toMatch(
      /<operaton:taskListener event="create" expression="\$\{audit\.log\(\)\}"\s*\/>/,
    );
    expect(block).toMatch(
      /<operaton:taskListener event="timeout" delegateExpression="\$\{escalate\}"\s*>/,
    );
    expect(block).toMatch(
      /<operaton:executionListener event="end">\s*<operaton:script scriptFormat="javascript">\s*log\(1\);\s*<\/operaton:script>\s*<\/operaton:executionListener>/,
    );

    // A timeout task listener also carries its timer as a bpmn child.
    expect(block).toMatch(
      /<operaton:taskListener event="timeout"[^>]*>\s*<bpmn:timerEventDefinition>\s*<bpmn:timeDuration[^>]*>\s*PT2H\s*<\/bpmn:timeDuration>\s*<\/bpmn:timerEventDefinition>\s*<\/operaton:taskListener>/,
    );
  });
});

describe('irToXml — extension-element assembly order', () => {
  it('emits every group a user task carries under one wrapper in canonical order', async () => {
    const nestedXml = await irToXml(nestedGroupsIr);
    expect(nestedXml.match(/<bpmn:extensionElements/g)).toHaveLength(1);

    const review = await engineNode(nestedXml, 'Review');
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

  it('places a call activity’s io block before its mappings and its retry cycle last', async () => {
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
 * Extract the XML block for a flow node element by its BPMN id. Works for
 * both self-closing and non-self-closing elements, returning the text from
 * the opening tag up to and including its closing tag (or the self-close `/>`)
 * so that we can count `<bpmn:incoming>` / `<bpmn:outgoing>` children within
 * the block without accidentally counting those of sibling elements.
 *
 * The approach is regex-based (good enough for our formatted output): we find
 * the first occurrence of `id="<nodeId>"` inside any `<bpmn:*` opening tag,
 * then scan forward for the matching closing tag.
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
