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
import type { BpmnProcess } from '../src/ir/types.js';

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
    // Regression guard for D5: the DI hint must only ever be attached when
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
          { kind: 'expression', sourceExpression: '${status}', target: 'final' },
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
