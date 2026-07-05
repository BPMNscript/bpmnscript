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
      javaClass: 'com.example.invoice.AutoApproveDelegate',
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
