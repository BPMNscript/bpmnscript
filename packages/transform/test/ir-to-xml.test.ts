/**
 * Full test suite for the IR → BPMN XML transform.
 *
 * Integration-level tests — `irToXml` calls `bpmn-auto-layout` which
 * performs real DOM layout, so each test exercises the full pipeline.
 *
 * Two complementary fixtures drive this suite:
 *
 *   A. `importShapedIr` — a hand-authored IR that mirrors what `xmlToIr`
 *      produces from `tests/golden/invoice-approval-handwritten.bpmn`. Its ids
 *      are the *imported* ids of the handwritten golden (`AmountCheck`,
 *      `AutoApprovePath`, `Flow_SeniorBranch`) and its gateway has no synthesized
 *      join (the handwritten process lets both branches converge directly on the
 *      end event). This fixture exercises `irToXml` in isolation — bpmn-moddle
 *      round-trip, Operaton attribute emission, and per-node incoming/outgoing
 *      degree — without depending on the parser or the desugarer.
 *
 *   B. The full pipeline — `irToXml(astToIr(parse(example.bpmnscript)))` on
 *      `examples/spring-boot/processes/invoice-approval.bpmnscript`. This is
 *      byte-compared against `tests/golden/invoice-approval-generated.bpmn`,
 *      the pinned output of the whole pipeline. Its gateway/default
 *      ids are the synthesized ids (`Gateway_invoice-approval_2_split`,
 *      `Flow_Gateway_invoice-approval_2_split_default`) and the `if`/`else`
 *      desugars to a paired split + join, distinct from the import-shaped
 *      fixture above.
 *
 * Keeping the two apart lets `importShapedIr` drive deterministic unit-level
 * checks decoupled from the parser, while the full-pipeline golden test pins
 * the real end-to-end output the engine E2E deploys.
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
 * Import-shaped IR — mirrors what `xmlToIr` produces from
 * `tests/golden/invoice-approval-handwritten.bpmn`. Its ids are the imported,
 * handwritten ids (`AmountCheck`, `AutoApprovePath`, `Flow_SeniorBranch`),
 * preserved verbatim on import. This
 * fixture drives the `irToXml`-isolation checks (bpmn-moddle round-trip,
 * Operaton attributes, per-node graph degree); it is not byte-compared
 * against the generated golden, which is now the full-pipeline output (see the
 * dedicated full-pipeline describe block below).
 *
 * Note: the start event (ReviewStart) and end event (Done) have no `name`
 * because the handwritten BPMN gives them no `name` attribute, and the gateway
 * has no synthesized join — both branches converge directly on `Done`, exactly
 * as the handwritten import does.
 */
const importShapedIr: BpmnProcess = {
  id: 'invoice-approval',
  name: 'Invoice Approval',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'ReviewStart' },
    {
      kind: 'userTask',
      id: 'ReviewInvoice',
      name: 'Review invoice',
      assignee: 'demo',
    },
    {
      kind: 'exclusiveGateway',
      id: 'AmountCheck',
      name: 'Amount > 1000?',
      defaultFlowId: 'AutoApprovePath',
    },
    {
      kind: 'userTask',
      id: 'SeniorApproval',
      name: 'Senior approval',
      assignee: 'manager',
    },
    {
      kind: 'serviceTask',
      id: 'AutoApprove',
      name: 'Auto-approve',
      binding: {
        kind: 'class',
        className: 'com.example.invoice.AutoApproveDelegate',
      },
    },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_ReviewStart_ReviewInvoice',
      sourceRef: 'ReviewStart',
      targetRef: 'ReviewInvoice',
    },
    {
      id: 'Flow_ReviewInvoice_AmountCheck',
      sourceRef: 'ReviewInvoice',
      targetRef: 'AmountCheck',
    },
    {
      id: 'Flow_SeniorBranch',
      conditionExpression: '${amount > 1000}',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
    },
    {
      id: 'AutoApprovePath',
      sourceRef: 'AmountCheck',
      targetRef: 'AutoApprove',
    },
    {
      id: 'Flow_SeniorApproval_Done',
      sourceRef: 'SeniorApproval',
      targetRef: 'Done',
    },
    {
      id: 'Flow_AutoApprove_Done',
      sourceRef: 'AutoApprove',
      targetRef: 'Done',
    },
  ],
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

  it('output is a non-empty string', () => {
    expect(typeof xml).toBe('string');
    expect(xml.length).toBeGreaterThan(0);
  });

  it('labels the conditioned flow with its bare condition text', () => {
    // Viewers render a flow's `name`, not its `conditionExpression`, so the
    // condition (minus the `${…}` delimiters) is mirrored as the edge label.
    // `>` may serialize as the numeric (`&#62;`) or named (`&gt;`) entity
    // depending on the writer; decode both so the assertion is encoding-robust.
    const decoded = xml.replace(/(&#62;|&gt;)/g, '>');
    expect(decoded).toContain('name="amount > 1000"');
  });
});

// ── 2. Expected Operaton attributes ──────────────────────────────────────────

describe('irToXml — Operaton extension attributes', () => {
  it('contains operaton:assignee="demo"', () => {
    expect(xml).toContain('operaton:assignee="demo"');
  });

  it('contains operaton:assignee="manager"', () => {
    expect(xml).toContain('operaton:assignee="manager"');
  });

  it('contains operaton:class="com.example.invoice.AutoApproveDelegate"', () => {
    expect(xml).toContain(
      'operaton:class="com.example.invoice.AutoApproveDelegate"',
    );
  });

  it('contains operaton:historyTimeToLive="P30D"', () => {
    expect(xml).toContain('operaton:historyTimeToLive="P30D"');
  });

  it('emits the bpmndi:BPMNDiagram block', () => {
    expect(xml).toMatch(/<bpmndi:BPMNDiagram\b/);
  });
});

// ── 3. Per-node incoming/outgoing count ──────────────────────────────────────

describe('irToXml — per-node incoming/outgoing graph degree', () => {
  /**
   * Parse the XML into a moddle graph and verify incoming/outgoing counts
   * for every flow node, matching the edges defined in the canonical IR —
   * a per-node check, not just aggregate totals.
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

  it('total incoming across all nodes equals number of sequence flows (6)', () => {
    const totalIncoming = (xml.match(/<bpmn:incoming>/g) ?? []).length;
    expect(totalIncoming).toBe(6);
  });

  it('total outgoing across all nodes equals number of sequence flows (6)', () => {
    const totalOutgoing = (xml.match(/<bpmn:outgoing>/g) ?? []).length;
    expect(totalOutgoing).toBe(6);
  });
});

// ── 4. Full-pipeline golden diff ─────────────────────────────────────────────

describe('irToXml — full-pipeline golden diff', () => {
  /**
   * Pins the whole pipeline:
   *
   *   parse(example.bpmnscript) → astToIr → irToXml  ≡  generated golden (bytes)
   *
   * The `examples/spring-boot/processes/invoice-approval.bpmnscript`
   * is parsed with the real Langium services (mirroring how
   * `tests/round-trip.test.ts` wires `parseHelper` + `EmptyFileSystem`),
   * desugared to IR, and serialized. The result must equal
   * `tests/golden/invoice-approval-generated.bpmn` byte-for-byte — this is the
   * golden the engine E2E deploys, so the synthesized gateway/flow ids
   * (`Gateway_invoice-approval_2_split`/`_join`,
   * `Flow_Gateway_invoice-approval_2_split_default`) are pinned here.
   *
   * Engine-contract values asserted alongside the byte diff: process id
   * `invoice-approval`, userTask ids `ReviewInvoice`/`SeniorApproval`,
   * `operaton:class` delegate, `operaton:assignee` demo/manager, and the
   * `${amount > 1000}` condition.
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

  it('uses the synthesized gateway/default-flow ids (paired split + join)', () => {
    expect(pipelineXml).toContain('id="Gateway_invoice-approval_2_split"');
    expect(pipelineXml).toContain('id="Gateway_invoice-approval_2_join"');
    expect(pipelineXml).toContain(
      'default="Flow_Gateway_invoice-approval_2_split_default"',
    );
  });
});

// ── 5. Parallel gateway serialization ────────────────────────────────────────

describe('irToXml — parallelGateway serialization', () => {
  /**
   * A minimal parallel split+join IR:
   *   Start → Fork (parallelGateway, 2 outgoing)
   *     → BranchA (userTask)
   *     → BranchB (userTask)
   *   BranchA, BranchB → Join (parallelGateway, 2 incoming)
   *   Join → End
   */
  const parallelIr: BpmnProcess = {
    id: 'parallel-proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'Start' },
      { kind: 'parallelGateway', id: 'Fork', name: 'Fork' },
      { kind: 'userTask', id: 'BranchA', name: 'Branch A' },
      { kind: 'userTask', id: 'BranchB', name: 'Branch B' },
      { kind: 'parallelGateway', id: 'Join', name: 'Join' },
      { kind: 'endEvent', id: 'End' },
    ],
    sequenceFlows: [
      { id: 'F_Start_Fork', sourceRef: 'Start', targetRef: 'Fork' },
      { id: 'F_Fork_A', sourceRef: 'Fork', targetRef: 'BranchA' },
      { id: 'F_Fork_B', sourceRef: 'Fork', targetRef: 'BranchB' },
      { id: 'F_A_Join', sourceRef: 'BranchA', targetRef: 'Join' },
      { id: 'F_B_Join', sourceRef: 'BranchB', targetRef: 'Join' },
      { id: 'F_Join_End', sourceRef: 'Join', targetRef: 'End' },
    ],
  };

  let parallelXml: string;

  beforeAll(async () => {
    parallelXml = await irToXml(parallelIr);
  });

  it('output contains bpmn:parallelGateway element for Fork', () => {
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Fork"/);
  });

  it('output contains bpmn:parallelGateway element for Join', () => {
    expect(parallelXml).toMatch(/bpmn:parallelGateway[^>]*id="Join"/);
  });

  it('Fork gateway has 1 incoming and 2 outgoing', () => {
    const block = extractNodeBlock(parallelXml, 'Fork');
    const incomingCount = (block.match(/<bpmn:incoming>/g) ?? []).length;
    const outgoingCount = (block.match(/<bpmn:outgoing>/g) ?? []).length;
    expect(incomingCount).toBe(1);
    expect(outgoingCount).toBe(2);
  });

  it('Join gateway has 2 incoming and 1 outgoing', () => {
    const block = extractNodeBlock(parallelXml, 'Join');
    const incomingCount = (block.match(/<bpmn:incoming>/g) ?? []).length;
    const outgoingCount = (block.match(/<bpmn:outgoing>/g) ?? []).length;
    expect(incomingCount).toBe(2);
    expect(outgoingCount).toBe(1);
  });

  it('output does not contain a default attribute on any parallelGateway', () => {
    // Extract all parallelGateway blocks and check none have default=
    const forkBlock = extractNodeBlock(parallelXml, 'Fork');
    const joinBlock = extractNodeBlock(parallelXml, 'Join');
    expect(forkBlock).not.toContain('default=');
    expect(joinBlock).not.toContain('default=');
  });

  it('parallelXml parses cleanly via bpmn-moddle', async () => {
    const moddle = new BpmnModdle({});
    const { warnings } = await moddle.fromXML(parallelXml);
    expect(warnings).toEqual([]);
  });

  it('contains bpmndi:BPMNDiagram block (layout applied)', () => {
    expect(parallelXml).toMatch(/<bpmndi:BPMNDiagram\b/);
  });
});

// ── 6. serviceTask binding variants ──────────────────────────────────────────

describe('irToXml — serviceTask binding variants', () => {
  /** Minimal single-task IR, parameterised over the service task's binding. */
  function singleServiceTaskIr(binding: BpmnProcess['flowElements'][number]) {
    return {
      id: 'binding-proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'Start' },
        binding,
        { kind: 'endEvent', id: 'End' },
      ],
      sequenceFlows: [
        { id: 'F_Start_Task', sourceRef: 'Start', targetRef: 'Task' },
        { id: 'F_Task_End', sourceRef: 'Task', targetRef: 'End' },
      ],
    } satisfies BpmnProcess;
  }

  it('expression binding emits operaton:expression', async () => {
    const ir = singleServiceTaskIr({
      kind: 'serviceTask',
      id: 'Task',
      binding: { kind: 'expression', expression: '${bean.method(execution)}' },
    });
    const out = await irToXml(ir);
    expect(out).toContain('operaton:expression="${bean.method(execution)}"');
  });

  it('delegateExpression binding emits operaton:delegateExpression', async () => {
    const ir = singleServiceTaskIr({
      kind: 'serviceTask',
      id: 'Task',
      binding: { kind: 'delegateExpression', expression: '${myDelegate}' },
    });
    const out = await irToXml(ir);
    expect(out).toContain('operaton:delegateExpression="${myDelegate}"');
  });

  it('external binding emits operaton:type="external" and operaton:topic', async () => {
    const ir = singleServiceTaskIr({
      kind: 'serviceTask',
      id: 'Task',
      binding: { kind: 'external', topic: 'shipping' },
    });
    const out = await irToXml(ir);
    expect(out).toContain('operaton:type="external"');
    expect(out).toContain('operaton:topic="shipping"');
  });
});

// ── 7. scriptTask serialization ──────────────────────────────────────────────

describe('irToXml — scriptTask serialization', () => {
  const scriptIr: BpmnProcess = {
    id: 'script-proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'Start' },
      {
        kind: 'scriptTask',
        id: 'Compute',
        format: 'javascript',
        code: 'var total = amount * 2;\nreturn total;',
      },
      { kind: 'endEvent', id: 'End' },
    ],
    sequenceFlows: [
      { id: 'F_Start_Compute', sourceRef: 'Start', targetRef: 'Compute' },
      { id: 'F_Compute_End', sourceRef: 'Compute', targetRef: 'End' },
    ],
  };

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

describe('irToXml — sub-process containment', () => {
  /**
   * Process `PStart → sub → PEnd`, where `sub` is an embedded sub-process
   * whose own body is `SubStart → Review → SubEnd`. The semantic element tree
   * (not the DI, which auto-layout regenerates) is inspected by parsing the
   * output back with raw `bpmn-moddle`.
   */
  const nestedIr: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'sub',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'Review', name: 'Review', assignee: 'demo' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          {
            id: 'SF_SubStart_Review',
            sourceRef: 'SubStart',
            targetRef: 'Review',
          },
          { id: 'SF_Review_SubEnd', sourceRef: 'Review', targetRef: 'SubEnd' },
        ],
      },
      { kind: 'endEvent', id: 'PEnd' },
    ],
    sequenceFlows: [
      { id: 'SF_PStart_sub', sourceRef: 'PStart', targetRef: 'sub' },
      { id: 'SF_sub_PEnd', sourceRef: 'sub', targetRef: 'PEnd' },
    ],
  };

  let proc: ModdleTree;
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

    // Nested nodes/flows never leak into the parent container's element list.
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
    const gatewayIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'sub',
          flowElements: [
            { kind: 'startEvent', id: 'SubStart' },
            {
              kind: 'exclusiveGateway',
              id: 'Gw',
              defaultFlowId: 'SF_Gw_B',
            },
            { kind: 'userTask', id: 'A' },
            { kind: 'userTask', id: 'B' },
            { kind: 'endEvent', id: 'SubEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_SubStart_Gw', sourceRef: 'SubStart', targetRef: 'Gw' },
            {
              id: 'SF_Gw_A',
              conditionExpression: '${ok}',
              sourceRef: 'Gw',
              targetRef: 'A',
            },
            { id: 'SF_Gw_B', sourceRef: 'Gw', targetRef: 'B' },
            { id: 'SF_A_End', sourceRef: 'A', targetRef: 'SubEnd' },
            { id: 'SF_B_End', sourceRef: 'B', targetRef: 'SubEnd' },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_sub', sourceRef: 'PStart', targetRef: 'sub' },
        { id: 'SF_sub_PEnd', sourceRef: 'sub', targetRef: 'PEnd' },
      ],
    };

    const tree = await parseProcessTree(await irToXml(gatewayIr));
    const sub = childById(tree, 'sub');
    const gw = childById(sub, 'Gw');
    expect(gw.$type).toBe('bpmn:ExclusiveGateway');
    // The `default` reference resolves to the nested flow, not a parent flow.
    expect(gw.default?.id).toBe('SF_Gw_B');
  });

  it('serializes two-level nesting recursively', async () => {
    const twoLevelIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'Outer',
          flowElements: [
            { kind: 'startEvent', id: 'OStart' },
            {
              kind: 'subProcess',
              id: 'Inner',
              flowElements: [
                { kind: 'startEvent', id: 'IStart' },
                { kind: 'userTask', id: 'Deep' },
                { kind: 'endEvent', id: 'IEnd' },
              ],
              sequenceFlows: [
                {
                  id: 'SF_IStart_Deep',
                  sourceRef: 'IStart',
                  targetRef: 'Deep',
                },
                { id: 'SF_Deep_IEnd', sourceRef: 'Deep', targetRef: 'IEnd' },
              ],
            },
            { kind: 'endEvent', id: 'OEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_OStart_Inner', sourceRef: 'OStart', targetRef: 'Inner' },
            { id: 'SF_Inner_OEnd', sourceRef: 'Inner', targetRef: 'OEnd' },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Outer', sourceRef: 'PStart', targetRef: 'Outer' },
        { id: 'SF_Outer_PEnd', sourceRef: 'Outer', targetRef: 'PEnd' },
      ],
    };

    const tree = await parseProcessTree(await irToXml(twoLevelIr));
    const outer = childById(tree, 'Outer');
    expect(outer.$type).toBe('bpmn:SubProcess');
    const inner = childById(outer, 'Inner');
    expect(inner.$type).toBe('bpmn:SubProcess');
    const deep = childById(inner, 'Deep');
    expect(deep.$type).toBe('bpmn:UserTask');
    // The innermost flows live only in the innermost container.
    const outerIds = (outer.flowElements ?? []).map((e) => e.id);
    expect(outerIds).not.toContain('SF_IStart_Deep');
  });
});

// ── 9. DI expansion hint for sub-processes ───────────────────────────────────

describe('irToXml — DI expansion hint for sub-processes', () => {
  /**
   * `bpmn-auto-layout` fed DI-less XML containing a `bpmn:subProcess` renders
   * it collapsed and scatters shapes for its children into the root plane —
   * garbage, not a degraded fallback. `irToXml` pre-seeds a minimal
   * `bpmndi:BPMNShape isExpanded="true"` per sub-process before layout so the
   * library expands the parent box and lays the children out inside it. This
   * block is the regression tripwire: if the hint is ever dropped, these
   * containment assertions are the first thing to go red.
   */
  const twoChildrenIr: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'sub',
        flowElements: [
          { kind: 'startEvent', id: 'SubStart' },
          { kind: 'userTask', id: 'ReviewA', name: 'Review A' },
          { kind: 'userTask', id: 'ReviewB', name: 'Review B' },
          { kind: 'endEvent', id: 'SubEnd' },
        ],
        sequenceFlows: [
          {
            id: 'SF_SubStart_ReviewA',
            sourceRef: 'SubStart',
            targetRef: 'ReviewA',
          },
          {
            id: 'SF_ReviewA_ReviewB',
            sourceRef: 'ReviewA',
            targetRef: 'ReviewB',
          },
          {
            id: 'SF_ReviewB_SubEnd',
            sourceRef: 'ReviewB',
            targetRef: 'SubEnd',
          },
        ],
      },
      { kind: 'endEvent', id: 'PEnd' },
    ],
    sequenceFlows: [
      { id: 'SF_PStart_sub', sourceRef: 'PStart', targetRef: 'sub' },
      { id: 'SF_sub_PEnd', sourceRef: 'sub', targetRef: 'PEnd' },
    ],
  };

  it('every nested child shape falls strictly inside its parent sub-process shape', async () => {
    const xml = await irToXml(twoChildrenIr);
    const shapes = await parseDiShapesById(xml);
    const parent = requireShape(shapes, 'sub');
    for (const childId of ['SubStart', 'ReviewA', 'ReviewB', 'SubEnd']) {
      const child = requireShape(shapes, childId);
      expect(boundsStrictlyInside(child.bounds, parent.bounds)).toBe(true);
    }
  });

  it('two-level nesting: inner sub-process sits inside the outer, inner children inside the inner', async () => {
    const twoLevelIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'Outer',
          flowElements: [
            { kind: 'startEvent', id: 'OStart' },
            {
              kind: 'subProcess',
              id: 'Inner',
              flowElements: [
                { kind: 'startEvent', id: 'IStart' },
                { kind: 'userTask', id: 'Deep' },
                { kind: 'endEvent', id: 'IEnd' },
              ],
              sequenceFlows: [
                {
                  id: 'SF_IStart_Deep',
                  sourceRef: 'IStart',
                  targetRef: 'Deep',
                },
                { id: 'SF_Deep_IEnd', sourceRef: 'Deep', targetRef: 'IEnd' },
              ],
            },
            { kind: 'endEvent', id: 'OEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_OStart_Inner', sourceRef: 'OStart', targetRef: 'Inner' },
            { id: 'SF_Inner_OEnd', sourceRef: 'Inner', targetRef: 'OEnd' },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Outer', sourceRef: 'PStart', targetRef: 'Outer' },
        { id: 'SF_Outer_PEnd', sourceRef: 'Outer', targetRef: 'PEnd' },
      ],
    };

    const xml = await irToXml(twoLevelIr);
    const shapes = await parseDiShapesById(xml);
    const outer = requireShape(shapes, 'Outer');
    const inner = requireShape(shapes, 'Inner');
    expect(boundsStrictlyInside(inner.bounds, outer.bounds)).toBe(true);
    for (const childId of ['IStart', 'Deep', 'IEnd']) {
      const child = requireShape(shapes, childId);
      expect(boundsStrictlyInside(child.bounds, inner.bounds)).toBe(true);
    }
  });

  it('emits exactly one bpmndi:BPMNDiagram (the layout-generated one replaces the stub)', async () => {
    const xml = await irToXml(twoChildrenIr);
    const diagramCount = (xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length;
    expect(diagramCount).toBe(1);
  });

  it('a sub-process-free process produces byte-identical output to the frozen golden', async () => {
    // Regression guard: the DI hint must only ever be attached when
    // the process actually contains a sub-process. This re-asserts the
    // full-pipeline golden byte-diff from the sub-process describe block
    // above, right next to the DI-hint logic that could regress it.
    const services = createBpmnScriptServices(EmptyFileSystem);
    const parse = parseHelper<Model>(services.BpmnScript);
    const src = readFileSync(EXAMPLE_BPMNSCRIPT_PATH, 'utf-8');
    const document = await parse(src);
    const ir = astToIr(document.parseResult.value);
    const generatedXml = await irToXml(ir);
    const goldenXml = readFileSync(GOLDEN_GENERATED_PATH, 'utf-8');
    expect(generatedXml).toBe(goldenXml);
  });

  it('an empty sub-process body does not throw', async () => {
    const emptySubIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'subProcess', id: 'sub', flowElements: [], sequenceFlows: [] },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_sub', sourceRef: 'PStart', targetRef: 'sub' },
        { id: 'SF_sub_PEnd', sourceRef: 'sub', targetRef: 'PEnd' },
      ],
    };
    await expect(irToXml(emptySubIr)).resolves.not.toThrow();
  });
});

// ── 10. callActivity serialization ───────────────────────────────────────────

describe('irToXml — callActivity serialization', () => {
  /**
   * `start → call → end`, where the call activity populates every feature:
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
  let call: CallModdle;

  beforeAll(async () => {
    // `irToXml` runs bpmn-auto-layout on the output; a throw here fails the
    // suite, which doubles as the "layout handles a call activity" check.
    callXml = await irToXml(richCallIr);
    const proc = await parseProcessTreeWithOperaton(callXml);
    call = childById(proc, 'CallSub') as unknown as CallModdle;
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
    const c = childById(proc, 'CallSub') as unknown as CallModdle;
    expect(c.calledElementBinding).toBe('version');
    expect(c.calledElementVersion).toBe('7');
  });

  it('emits neither binding attribute when no binding is present', async () => {
    const ir = minimalCallIr({
      kind: 'callActivity',
      id: 'CallSub',
      calledElement: 'sub',
    });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub') as unknown as CallModdle;
    expect(c.calledElementBinding).toBeUndefined();
    expect(c.calledElementVersion).toBeUndefined();
  });

  it('emits no extensionElements for a minimal call (calledElement only)', async () => {
    const ir = minimalCallIr({
      kind: 'callActivity',
      id: 'CallSub',
      calledElement: 'sub',
    });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'CallSub') as unknown as CallModdle;
    expect(c.extensionElements).toBeUndefined();
  });

  it('derives a humanized name for an unnamed call activity', async () => {
    const ir = minimalCallIr({
      kind: 'callActivity',
      id: 'ProcessPayment',
      calledElement: 'sub',
    });
    const proc = await parseProcessTreeWithOperaton(await irToXml(ir));
    const c = childById(proc, 'ProcessPayment') as unknown as CallModdle;
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
   * Handlers are disconnected (no incoming/outgoing) — event sub-processes are
   * triggered, not flow-connected.
   */
  const eventIr: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    errorMessages: [{ code: 'PF', message: 'boom' }],
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'OuterSub',
        flowElements: [
          { kind: 'startEvent', id: 'OSubStart' },
          { kind: 'userTask', id: 'OWork', assignee: 'demo' },
          { kind: 'endEvent', id: 'OSubEnd' },
          {
            kind: 'subProcess',
            id: 'ErrHandler',
            triggeredByEvent: true,
            flowElements: [
              {
                kind: 'startEvent',
                id: 'ErrStart',
                eventDefinition: {
                  kind: 'error',
                  errorCode: 'PF',
                  codeVariable: 'c',
                  messageVariable: 'm',
                },
              },
              { kind: 'userTask', id: 'Recover' },
              { kind: 'endEvent', id: 'ErrEnd' },
            ],
            sequenceFlows: [
              {
                id: 'SF_ErrStart_Recover',
                sourceRef: 'ErrStart',
                targetRef: 'Recover',
              },
              {
                id: 'SF_Recover_ErrEnd',
                sourceRef: 'Recover',
                targetRef: 'ErrEnd',
              },
            ],
          },
        ],
        sequenceFlows: [
          {
            id: 'SF_OSubStart_OWork',
            sourceRef: 'OSubStart',
            targetRef: 'OWork',
          },
          { id: 'SF_OWork_OSubEnd', sourceRef: 'OWork', targetRef: 'OSubEnd' },
        ],
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'Emit1',
        eventDefinition: { kind: 'escalation', escalationCode: 'LS' },
      },
      {
        kind: 'endEvent',
        id: 'ThrowPF',
        eventDefinition: { kind: 'error', errorCode: 'PF' },
      },
      {
        kind: 'subProcess',
        id: 'EscHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'EscStart',
            isInterrupting: false,
            eventDefinition: {
              kind: 'escalation',
              escalationCode: 'LS',
              codeVariable: 'v',
            },
          },
          { kind: 'userTask', id: 'Notify' },
          { kind: 'endEvent', id: 'EscEnd' },
        ],
        sequenceFlows: [
          {
            id: 'SF_EscStart_Notify',
            sourceRef: 'EscStart',
            targetRef: 'Notify',
          },
          { id: 'SF_Notify_EscEnd', sourceRef: 'Notify', targetRef: 'EscEnd' },
        ],
      },
    ],
    sequenceFlows: [
      { id: 'SF_PStart_OuterSub', sourceRef: 'PStart', targetRef: 'OuterSub' },
      { id: 'SF_OuterSub_Emit1', sourceRef: 'OuterSub', targetRef: 'Emit1' },
      { id: 'SF_Emit1_ThrowPF', sourceRef: 'Emit1', targetRef: 'ThrowPF' },
    ],
  };

  let defs: EventNode;

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
    // Both refs resolve to the very same root element object.
    expect(errorDef(handlerStart).errorRef?.id).toBe('Error_PF');
    expect(errorDef(throwEnd).errorRef?.id).toBe('Error_PF');
  });

  it('synthesizes exactly one bpmn:Escalation root, shared by the handler and the emit', () => {
    const escalations = rootsOfType(defs, 'bpmn:Escalation');
    expect(escalations).toHaveLength(1);
    const escRoot = escalations[0]!;
    expect(escRoot.id).toBe('Escalation_LS');
    expect(escRoot.escalationCode).toBe('LS');

    const handlerStart = requireDeep(defs, 'EscStart');
    const emit = requireDeep(defs, 'Emit1');
    expect(escalationDef(handlerStart).escalationRef?.id).toBe('Escalation_LS');
    expect(escalationDef(emit).escalationRef?.id).toBe('Escalation_LS');
  });

  it('orders rootElements as [process, ...errors, ...escalations]', () => {
    const types = defs.rootElements.map((r) => r.$type);
    expect(types).toEqual(['bpmn:Process', 'bpmn:Error', 'bpmn:Escalation']);
  });

  it('flags the error handler triggeredByEvent and stamps the catch bindings on its start', () => {
    const handler = requireDeep(defs, 'ErrHandler');
    expect(handler.$type).toBe('bpmn:SubProcess');
    expect(handler.triggeredByEvent).toBe(true);

    const def = errorDef(requireDeep(defs, 'ErrStart'));
    expect(def.$type).toBe('bpmn:ErrorEventDefinition');
    expect(def.errorCodeVariable).toBe('c');
    expect(def.errorMessageVariable).toBe('m');
  });

  it('marks the alongside escalation handler start non-interrupting with its code binding', () => {
    const start = requireDeep(defs, 'EscStart');
    expect(start.isInterrupting).toBe(false);
    const def = escalationDef(start);
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
    const catchAllIr: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'endEvent', id: 'E' },
        {
          kind: 'subProcess',
          id: 'AnyErr',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'AnyStart',
              eventDefinition: { kind: 'error' },
            },
            { kind: 'userTask', id: 'Log' },
            { kind: 'endEvent', id: 'AnyEnd' },
          ],
          sequenceFlows: [
            { id: 'SF_AnyStart_Log', sourceRef: 'AnyStart', targetRef: 'Log' },
            { id: 'SF_Log_AnyEnd', sourceRef: 'Log', targetRef: 'AnyEnd' },
          ],
        },
      ],
      sequenceFlows: [{ id: 'SF_S_E', sourceRef: 'S', targetRef: 'E' }],
    };
    const d = await parseDefinitionsWithOperaton(await irToXml(catchAllIr));
    expect(rootsOfType(d, 'bpmn:Error')).toHaveLength(0);
    expect(errorDef(requireDeep(d, 'AnyStart')).errorRef).toBeUndefined();
  });

  it('shares one root across two handlers and a throw of the same code', async () => {
    const handler = (id: string): FlowElement => ({
      kind: 'subProcess',
      id,
      triggeredByEvent: true,
      flowElements: [
        {
          kind: 'startEvent',
          id: `${id}_S`,
          eventDefinition: { kind: 'error', errorCode: 'DUP' },
        },
        { kind: 'endEvent', id: `${id}_E` },
      ],
      sequenceFlows: [
        { id: `SF_${id}`, sourceRef: `${id}_S`, targetRef: `${id}_E` },
      ],
    });
    const sharedIr: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'T',
          eventDefinition: { kind: 'error', errorCode: 'DUP' },
        },
        handler('H1'),
        handler('H2'),
      ],
      sequenceFlows: [{ id: 'SF_S_T', sourceRef: 'S', targetRef: 'T' }],
    };
    const d = await parseDefinitionsWithOperaton(await irToXml(sharedIr));
    const errors = rootsOfType(d, 'bpmn:Error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('Error_DUP');
  });

  it('sanitizes a root id from a code with non-id characters', async () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'endEvent',
          id: 'T',
          eventDefinition: { kind: 'error', errorCode: 'NEEDS REVIEW!' },
        },
      ],
      sequenceFlows: [{ id: 'SF_S_T', sourceRef: 'S', targetRef: 'T' }],
    };
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
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Error_Boom' },
        {
          kind: 'endEvent',
          id: 'T',
          eventDefinition: { kind: 'error', errorCode: 'Boom' },
        },
      ],
      sequenceFlows: [
        { id: 'SF_S_X', sourceRef: 'S', targetRef: 'Error_Boom' },
        { id: 'SF_X_T', sourceRef: 'Error_Boom', targetRef: 'T' },
      ],
    };
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

    const escHandler = requireShape(shapes, 'EscHandler');
    for (const child of ['EscStart', 'Notify', 'EscEnd']) {
      expect(
        boundsStrictlyInside(
          requireShape(shapes, child).bounds,
          escHandler.bounds,
        ),
      ).toBe(true);
    }

    const outerSub = requireShape(shapes, 'OuterSub');
    const errHandler = requireShape(shapes, 'ErrHandler');
    // The nested event sub-process sits inside its parent sub-process.
    expect(boundsStrictlyInside(errHandler.bounds, outerSub.bounds)).toBe(true);
    for (const child of ['ErrStart', 'Recover', 'ErrEnd']) {
      expect(
        boundsStrictlyInside(
          requireShape(shapes, child).bounds,
          errHandler.bounds,
        ),
      ).toBe(true);
    }
  });
});

// ── 12. Event layer: message + signal + timer + conditional ──────────────────

/** Build an event sub-process (`on …` handler) wrapping a start/user/end body. */
function eventHandler(
  id: string,
  startId: string,
  def: EventDefinition,
  isInterrupting?: false,
): FlowElement {
  const start: FlowElement =
    isInterrupting === false
      ? {
          kind: 'startEvent',
          id: startId,
          isInterrupting,
          eventDefinition: def,
        }
      : { kind: 'startEvent', id: startId, eventDefinition: def };
  return {
    kind: 'subProcess',
    id,
    triggeredByEvent: true,
    flowElements: [
      start,
      { kind: 'userTask', id: `${id}_Work` },
      { kind: 'endEvent', id: `${id}_End` },
    ],
    sequenceFlows: [
      { id: `SF_${id}_a`, sourceRef: startId, targetRef: `${id}_Work` },
      { id: `SF_${id}_b`, sourceRef: `${id}_Work`, targetRef: `${id}_End` },
    ],
  };
}

describe('irToXml — event layer (message + signal + timer + conditional)', () => {
  /**
   * A process exercising message/signal handlers plus both signal throw forms:
   *   - An interrupting `on message "PaymentReceived"` handler.
   *   - An `alongside` `on signal "Cancelled"` handler.
   *   - An `emit signal "Cancelled"` intermediate throw mid-chain.
   *   - A `throw signal "Cancelled"` end event — sharing the one signal root.
   */
  const signalIr: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      eventHandler('MsgHandler', 'MsgStart', {
        kind: 'message',
        messageName: 'PaymentReceived',
      }),
      eventHandler(
        'SigHandler',
        'SigStart',
        { kind: 'signal', signalName: 'Cancelled' },
        false,
      ),
      {
        kind: 'intermediateThrowEvent',
        id: 'EmitSig',
        eventDefinition: { kind: 'signal', signalName: 'Cancelled' },
      },
      {
        kind: 'endEvent',
        id: 'ThrowSig',
        eventDefinition: { kind: 'signal', signalName: 'Cancelled' },
      },
    ],
    sequenceFlows: [
      { id: 'SF_PStart_EmitSig', sourceRef: 'PStart', targetRef: 'EmitSig' },
      {
        id: 'SF_EmitSig_ThrowSig',
        sourceRef: 'EmitSig',
        targetRef: 'ThrowSig',
      },
    ],
  };

  let defs: EventNode;

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
    for (const [handler, children] of [
      ['MsgHandler', ['MsgStart', 'MsgHandler_Work', 'MsgHandler_End']],
      ['SigHandler', ['SigStart', 'SigHandler_Work', 'SigHandler_End']],
    ] as const) {
      const box = requireShape(shapes, handler);
      for (const child of children) {
        expect(
          boundsStrictlyInside(requireShape(shapes, child).bounds, box.bounds),
        ).toBe(true);
      }
    }
  });

  it('emits one FormalExpression child per timer kind with the verbatim body, and no roots', async () => {
    const timerIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'endEvent', id: 'PEnd' },
        eventHandler('AfterH', 'AfterStart', {
          kind: 'timer',
          timerKind: 'duration',
          expression: 'PT1H',
        }),
        eventHandler('AtH', 'AtStart', {
          kind: 'timer',
          timerKind: 'date',
          expression: '${dueDate}',
        }),
        eventHandler('EveryH', 'EveryStart', {
          kind: 'timer',
          timerKind: 'cycle',
          expression: 'R/PT10M',
        }),
        eventHandler('CondH', 'CondStart', {
          kind: 'conditional',
          condition: '${amount > 100}',
        }),
      ],
      sequenceFlows: [
        { id: 'SF_PStart_PEnd', sourceRef: 'PStart', targetRef: 'PEnd' },
      ],
    };
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
    const mixedIr: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        {
          kind: 'intermediateThrowEvent',
          id: 'EmitEsc',
          eventDefinition: { kind: 'escalation', escalationCode: 'LS' },
        },
        {
          kind: 'intermediateThrowEvent',
          id: 'EmitSig',
          eventDefinition: { kind: 'signal', signalName: 'Cancelled' },
        },
        {
          kind: 'endEvent',
          id: 'ThrowErr',
          eventDefinition: { kind: 'error', errorCode: 'PF' },
        },
        eventHandler('MsgHandler', 'MsgStart', {
          kind: 'message',
          messageName: 'Order received!',
        }),
      ],
      sequenceFlows: [
        { id: 'SF_S_EmitEsc', sourceRef: 'S', targetRef: 'EmitEsc' },
        {
          id: 'SF_EmitEsc_EmitSig',
          sourceRef: 'EmitEsc',
          targetRef: 'EmitSig',
        },
        {
          id: 'SF_EmitSig_ThrowErr',
          sourceRef: 'EmitSig',
          targetRef: 'ThrowErr',
        },
      ],
    };
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
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'userTask', id: 'Signal_Ping' },
        {
          kind: 'intermediateThrowEvent',
          id: 'Emit',
          eventDefinition: { kind: 'signal', signalName: 'Ping' },
        },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'SF_S_X', sourceRef: 'S', targetRef: 'Signal_Ping' },
        { id: 'SF_X_Emit', sourceRef: 'Signal_Ping', targetRef: 'Emit' },
        { id: 'SF_Emit_E', sourceRef: 'Emit', targetRef: 'E' },
      ],
    };
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
   * Compensation is payload-less, so none of these carry a code — unlike the
   * error/escalation fixture above, there is no identity to share a root over.
   */
  const compensationIr: BpmnProcess = {
    id: 'proc',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'OuterSub',
        flowElements: [
          { kind: 'startEvent', id: 'OSubStart' },
          { kind: 'userTask', id: 'OWork', assignee: 'demo' },
          { kind: 'endEvent', id: 'OSubEnd' },
          eventHandler('CompHandler', 'CompStart', { kind: 'compensation' }),
        ],
        sequenceFlows: [
          {
            id: 'SF_OSubStart_OWork',
            sourceRef: 'OSubStart',
            targetRef: 'OWork',
          },
          { id: 'SF_OWork_OSubEnd', sourceRef: 'OWork', targetRef: 'OSubEnd' },
        ],
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'EmitComp',
        eventDefinition: { kind: 'compensation' },
      },
      {
        kind: 'endEvent',
        id: 'ThrowComp',
        eventDefinition: { kind: 'compensation' },
      },
    ],
    sequenceFlows: [
      { id: 'SF_PStart_OuterSub', sourceRef: 'PStart', targetRef: 'OuterSub' },
      {
        id: 'SF_OuterSub_EmitComp',
        sourceRef: 'OuterSub',
        targetRef: 'EmitComp',
      },
      {
        id: 'SF_EmitComp_ThrowComp',
        sourceRef: 'EmitComp',
        targetRef: 'ThrowComp',
      },
    ],
  };

  let defs: EventNode;
  let xml: string;

  beforeAll(async () => {
    xml = await irToXml(compensationIr);
    defs = await parseDefinitionsWithOperaton(xml);
  });

  it('emits the handler start with a bare CompensateEventDefinition and no isInterrupting attribute', () => {
    // Raw-XML assertion (not the parsed moddle object): bpmn-moddle applies
    // the schema default (`waitForCompletion`/`isInterrupting` both default to
    // `true`) when reading an attribute back, so the parsed tree would show
    // `true` either way. Checking the serialized text is the only way to pin
    // that the attribute itself is genuinely absent from the output.
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
        eventHandler('ErrHandler', 'ErrStart', {
          kind: 'error',
          errorCode: 'PF',
        }),
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

    const outerSub = requireShape(shapes, 'OuterSub');
    const handler = requireShape(shapes, 'CompHandler');
    expect(boundsStrictlyInside(handler.bounds, outerSub.bounds)).toBe(true);

    for (const child of ['CompStart', 'CompHandler_Work', 'CompHandler_End']) {
      expect(
        boundsStrictlyInside(
          requireShape(shapes, child).bounds,
          handler.bounds,
        ),
      ).toBe(true);
    }
  });
});

// ── 14. Boundary events ───────────────────────────────────────────────────────

/**
 * A minimal process with one host activity carrying one boundary event:
 * `PStart → Host → PEnd` in the main flow, plus a `boundaryEvent` attached to
 * `Host` whose one outgoing flow lands on its own end event — the shape a
 * hosted handler with an empty body lowers to.
 */
function hostedBoundaryIr(
  eventDefinition: EventDefinition,
  cancelActivity?: false,
): BpmnProcess {
  return {
    id: 'proc',
    isExecutable: true,
    flowElements: [
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
    sequenceFlows: [
      { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
      { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
      {
        id: 'SF_Boundary_BoundaryEnd',
        sourceRef: 'Boundary_Host_x',
        targetRef: 'BoundaryEnd',
      },
    ],
  };
}

describe('irToXml — boundary events', () => {
  it('emits a bpmn:BoundaryEvent attached to its host with no cancelActivity attribute when interrupting', async () => {
    const xml = await irToXml(
      hostedBoundaryIr({ kind: 'message', messageName: 'Ping' }),
    );
    const defs = await parseDefinitionsWithOperaton(xml);
    const boundary = requireDeep(defs, 'Boundary_Host_x');
    expect(boundary.$type).toBe('bpmn:BoundaryEvent');
    expect(boundary.attachedToRef?.id).toBe('Host');
    // Raw-XML assertion: bpmn-moddle applies the schema default
    // (`cancelActivity` defaults to `true`) when reading the attribute back,
    // so a parsed check can't distinguish "absent" from "explicitly true".
    // Only the serialized text pins that the attribute is genuinely absent.
    expect(extractNodeBlock(xml, 'Boundary_Host_x')).not.toContain(
      'cancelActivity',
    );
    // A boundary event carries no humanized name: its id is synthesized, so a
    // derived label would be noise in the diagram and churn in the goldens.
    expect(boundary.name).toBeUndefined();
  });

  it('emits cancelActivity="false" for a non-interrupting (alongside) boundary', async () => {
    const xml = await irToXml(
      hostedBoundaryIr({ kind: 'message', messageName: 'Ping' }, false),
    );
    const defs = await parseDefinitionsWithOperaton(xml);
    expect(requireDeep(defs, 'Boundary_Host_x').cancelActivity).toBe(false);
    expect(extractNodeBlock(xml, 'Boundary_Host_x')).toContain(
      'cancelActivity="false"',
    );
  });

  it.each<[string, EventDefinition, string]>([
    ['error', { kind: 'error', errorCode: 'PF' }, 'bpmn:ErrorEventDefinition'],
    [
      'escalation',
      { kind: 'escalation', escalationCode: 'LS' },
      'bpmn:EscalationEventDefinition',
    ],
    [
      'message',
      { kind: 'message', messageName: 'Ping' },
      'bpmn:MessageEventDefinition',
    ],
    [
      'signal',
      { kind: 'signal', signalName: 'Cancelled' },
      'bpmn:SignalEventDefinition',
    ],
    [
      'timer',
      { kind: 'timer', timerKind: 'duration', expression: 'PT1H' },
      'bpmn:TimerEventDefinition',
    ],
    [
      'conditional',
      { kind: 'conditional', condition: '${amount > 100}' },
      'bpmn:ConditionalEventDefinition',
    ],
  ])(
    'carries the %s event definition child',
    async (_label, def, expectedType) => {
      const defs = await parseDefinitionsWithOperaton(
        await irToXml(hostedBoundaryIr(def)),
      );
      expect(soleDef(requireDeep(defs, 'Boundary_Host_x')).$type).toBe(
        expectedType,
      );
    },
  );

  it('carries an outgoing sequence flow and no incoming', async () => {
    const defs = await parseDefinitionsWithOperaton(
      await irToXml(hostedBoundaryIr({ kind: 'message', messageName: 'Ping' })),
    );
    const boundary = requireDeep(defs, 'Boundary_Host_x');
    expect(boundary.incoming ?? []).toHaveLength(0);
    expect((boundary.outgoing ?? []).map((f) => f.id)).toEqual([
      'SF_Boundary_BoundaryEnd',
    ]);
  });

  it('serializes two boundary events attached to one host', async () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Host' },
        { kind: 'endEvent', id: 'PEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Host_error',
          attachedToRef: 'Host',
          eventDefinition: { kind: 'error', errorCode: 'PF' },
        },
        { kind: 'endEvent', id: 'ErrEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Host_timer',
          attachedToRef: 'Host',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'duration',
            expression: 'PT1H',
          },
        },
        { kind: 'endEvent', id: 'TimerEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
        { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
        {
          id: 'SF_ErrB_ErrEnd',
          sourceRef: 'Boundary_Host_error',
          targetRef: 'ErrEnd',
        },
        {
          id: 'SF_TimerB_TimerEnd',
          sourceRef: 'Boundary_Host_timer',
          targetRef: 'TimerEnd',
        },
      ],
    };
    const defs = await parseDefinitionsWithOperaton(await irToXml(ir));
    const errBoundary = requireDeep(defs, 'Boundary_Host_error');
    const timerBoundary = requireDeep(defs, 'Boundary_Host_timer');
    expect(errBoundary.$type).toBe('bpmn:BoundaryEvent');
    expect(timerBoundary.$type).toBe('bpmn:BoundaryEvent');
    expect(errBoundary.attachedToRef?.id).toBe('Host');
    expect(timerBoundary.attachedToRef?.id).toBe('Host');
  });

  it('serializes a boundary event on a sub-process host with exactly one bpmndi:BPMNDiagram', async () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'HostSub',
          flowElements: [
            { kind: 'startEvent', id: 'SubStart' },
            { kind: 'userTask', id: 'SubWork' },
            { kind: 'endEvent', id: 'SubEnd' },
          ],
          sequenceFlows: [
            {
              id: 'SF_SubStart_SubWork',
              sourceRef: 'SubStart',
              targetRef: 'SubWork',
            },
            {
              id: 'SF_SubWork_SubEnd',
              sourceRef: 'SubWork',
              targetRef: 'SubEnd',
            },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_HostSub_escalation',
          attachedToRef: 'HostSub',
          eventDefinition: { kind: 'escalation', escalationCode: 'LS' },
        },
        { kind: 'endEvent', id: 'EscEnd' },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_HostSub', sourceRef: 'PStart', targetRef: 'HostSub' },
        { id: 'SF_HostSub_PEnd', sourceRef: 'HostSub', targetRef: 'PEnd' },
        {
          id: 'SF_Boundary_EscEnd',
          sourceRef: 'Boundary_HostSub_escalation',
          targetRef: 'EscEnd',
        },
      ],
    };
    const xml = await irToXml(ir);
    expect((xml.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length).toBe(1);
    const defs = await parseDefinitionsWithOperaton(xml);
    const boundary = requireDeep(defs, 'Boundary_HostSub_escalation');
    expect(boundary.attachedToRef?.id).toBe('HostSub');
  });

  it('throws when a boundary event references an unknown host', async () => {
    const ir = hostedBoundaryIr({ kind: 'message', messageName: 'Ping' });
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
    // The misleading case: the id does exist in the document, just not where a
    // boundary event may reach it. A bare "unknown id" message would send a
    // reader looking for a missing element instead of a misplaced attachment.
    const nested: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'Sub',
          flowElements: [{ kind: 'userTask', id: 'Host' }],
          sequenceFlows: [],
        },
        { kind: 'endEvent', id: 'PEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Host_x',
          attachedToRef: 'Host',
          eventDefinition: { kind: 'message', messageName: 'Ping' },
        },
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Sub', sourceRef: 'PStart', targetRef: 'Sub' },
        { id: 'SF_Sub_PEnd', sourceRef: 'Sub', targetRef: 'PEnd' },
      ],
    };
    await expect(irToXml(nested)).rejects.toThrow(
      'BoundaryEvent "Boundary_Host_x" is attached to "Host", which is not a flow element of this container.',
    );
  });

  it('shares one root across a message caught by a boundary event and by a host-less handler', async () => {
    const ir: BpmnProcess = {
      id: 'proc',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        { kind: 'userTask', id: 'Host' },
        { kind: 'endEvent', id: 'PEnd' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Host_message',
          attachedToRef: 'Host',
          eventDefinition: { kind: 'message', messageName: 'Shared' },
        },
        { kind: 'endEvent', id: 'BoundaryEnd' },
        eventHandler('MsgHandler', 'MsgStart', {
          kind: 'message',
          messageName: 'Shared',
        }),
      ],
      sequenceFlows: [
        { id: 'SF_PStart_Host', sourceRef: 'PStart', targetRef: 'Host' },
        { id: 'SF_Host_PEnd', sourceRef: 'Host', targetRef: 'PEnd' },
        {
          id: 'SF_Boundary_BoundaryEnd',
          sourceRef: 'Boundary_Host_message',
          targetRef: 'BoundaryEnd',
        },
      ],
    };
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A parsed moddle node navigated for the event layer (roots, refs, defs). */
interface EventNode {
  $type: string;
  id?: string;
  name?: string;
  errorCode?: string;
  escalationCode?: string;
  errorMessage?: string;
  isInterrupting?: boolean;
  triggeredByEvent?: boolean;
  flowElements?: EventNode[];
  eventDefinitions?: EventNode[];
  incoming?: Array<{ id: string }>;
  outgoing?: Array<{ id: string }>;
  errorRef?: { id: string };
  escalationRef?: { id: string };
  messageRef?: { id: string; name?: string };
  signalRef?: { id: string; name?: string };
  condition?: { $type: string; body?: string };
  timeDuration?: { $type: string; body?: string };
  timeDate?: { $type: string; body?: string };
  timeCycle?: { $type: string; body?: string };
  errorCodeVariable?: string;
  errorMessageVariable?: string;
  escalationCodeVariable?: string;
  rootElements: EventNode[];
}

/**
 * Parse a BPMN XML string with the Operaton extension registered and return the
 * `bpmn:Definitions` root, so both the semantic tree (`rootElements`, nested
 * `flowElements`) and the Operaton-namespaced event attributes resolve to typed
 * properties.
 */
async function parseDefinitionsWithOperaton(
  xmlStr: string,
): Promise<EventNode> {
  const { rootElement } = await operatonModdle().fromXML(xmlStr);
  return rootElement as unknown as EventNode;
}

/** Every root element of a given `$type` (e.g. `bpmn:Error`). */
function rootsOfType(defs: EventNode, $type: string): EventNode[] {
  return defs.rootElements.filter((r) => r.$type === $type);
}

/** The single `bpmn:Process` root. */
function processRoot(defs: EventNode): EventNode {
  const proc = defs.rootElements.find((r) => r.$type === 'bpmn:Process');
  if (proc === undefined) throw new Error('No bpmn:Process root found.');
  return proc;
}

/** Recursively locate a flow node by id anywhere under the process, or throw. */
function requireDeep(defs: EventNode, id: string): EventNode {
  const found = deepFind(processRoot(defs), id);
  if (found === undefined) {
    throw new Error(`Flow node id="${id}" not found in the process tree.`);
  }
  return found;
}

function deepFind(container: EventNode, id: string): EventNode | undefined {
  for (const el of container.flowElements ?? []) {
    if (el.id === id) return el;
    const nested = deepFind(el, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The sole `bpmn:ErrorEventDefinition` on an event node. */
function errorDef(node: EventNode): EventNode {
  const def = (node.eventDefinitions ?? [])[0];
  if (def === undefined) {
    throw new Error(`Node id="${node.id}" carries no event definition.`);
  }
  return def;
}

/** The sole `bpmn:EscalationEventDefinition` on an event node. */
function escalationDef(node: EventNode): EventNode {
  return errorDef(node);
}

/** The sole event definition on an event node, whatever its kind. */
const soleDef = errorDef;

/** Minimal `start → call → end` wrapper around one call-activity node. */
function minimalCallIr(call: BpmnProcess['flowElements'][number]): BpmnProcess {
  return {
    id: 'caller',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'Start' },
      call,
      { kind: 'endEvent', id: 'End' },
    ],
    sequenceFlows: [
      { id: 'F_Start_Call', sourceRef: 'Start', targetRef: call.id },
      { id: 'F_Call_End', sourceRef: call.id, targetRef: 'End' },
    ],
  } satisfies BpmnProcess;
}

/** A parsed `bpmn:CallActivity` with the Operaton extension attributes/children. */
interface CallModdle {
  $type: string;
  name?: string;
  calledElement?: string;
  calledElementBinding?: string;
  calledElementVersion?: string;
  incoming?: Array<{ id: string }>;
  outgoing?: Array<{ id: string }>;
  extensionElements?: {
    values: Array<{
      $type: string;
      source?: string;
      sourceExpression?: string;
      variables?: string;
      target?: string;
      businessKey?: string;
      local?: boolean;
    }>;
  };
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
async function parseProcessTreeWithOperaton(
  xmlStr: string,
): Promise<ModdleTree> {
  const { rootElement } = await operatonModdle().fromXML(xmlStr);
  const roots = (rootElement as unknown as { rootElements: ModdleTree[] })
    .rootElements;
  const proc = roots.find((e) => e.$type === 'bpmn:Process');
  if (proc === undefined) {
    throw new Error('No bpmn:Process found in parsed output.');
  }
  return proc;
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
 * represents (`shape.bpmnElement`). Used to assert on the generated layout —
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

/** Whether `inner` is fully, strictly contained within `outer` (no touching edges). */
function boundsStrictlyInside(inner: DiBounds, outer: DiBounds): boolean {
  return (
    inner.x > outer.x &&
    inner.y > outer.y &&
    inner.x + inner.width < outer.x + outer.width &&
    inner.y + inner.height < outer.y + outer.height
  );
}

/** A parsed moddle element, navigated structurally rather than by regex. */
interface ModdleTree {
  $type: string;
  id: string;
  flowElements?: ModdleTree[];
  incoming?: ModdleTree[];
  outgoing?: ModdleTree[];
  sourceRef?: ModdleTree;
  targetRef?: ModdleTree;
  default?: ModdleTree;
}

/**
 * Parse a BPMN XML string with raw `bpmn-moddle` and return the root
 * `bpmn:Process` element as a navigable tree. Used to inspect the semantic
 * element structure (nesting, references) without asserting on DI shapes.
 */
async function parseProcessTree(xmlStr: string): Promise<ModdleTree> {
  const moddle = new BpmnModdle({});
  const { rootElement } = await moddle.fromXML(xmlStr);
  const roots = (rootElement as unknown as { rootElements: ModdleTree[] })
    .rootElements;
  const proc = roots.find((e) => e.$type === 'bpmn:Process');
  if (proc === undefined) {
    throw new Error('No bpmn:Process found in parsed output.');
  }
  return proc;
}

/** Find a direct child flow element (node or flow) of a container by id. */
function childById(container: ModdleTree, id: string): ModdleTree {
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
