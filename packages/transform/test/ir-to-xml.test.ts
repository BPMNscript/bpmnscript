/**
 * Full test suite for the IR → BPMN XML transform with golden diff.
 *
 * Integration-level tests — `irToXml` calls `bpmn-auto-layout` which
 * performs real DOM layout, so each test exercises the full pipeline.
 *
 * Test cases:
 *   1. `irToXml(canonical)` parses cleanly via `bpmn-moddle.fromXML`.
 *   2. Output contains expected Operaton attributes (string search).
 *   3. Every flow node has `<bpmn:incoming>` AND `<bpmn:outgoing>` with counts
 *      matching the graph degree (per-node check, not just aggregate).
 *   4. Golden diff: output equals `tests/golden/invoice-approval-generated.bpmn`.
 *
 * The "canonical IR" used here is derived from `tests/golden/invoice-approval-handwritten.bpmn`
 * (via `xmlToIr`) — matching the IR that was used to generate
 * `invoice-approval-generated.bpmn`. Using the handwritten file as the source
 * of truth makes the golden diff deterministic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpmnModdle } from 'bpmn-moddle';

import { irToXml } from '../src/ir-to-xml.js';
import type { BpmnProcess } from '../src/ir/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_GENERATED_PATH = resolve(
  here,
  '../../../tests/golden/invoice-approval-generated.bpmn',
);

/**
 * Canonical IR — matches the IR that `xmlToIr` produces from
 * `tests/golden/invoice-approval-handwritten.bpmn`, which in turn was used to
 * generate `tests/golden/invoice-approval-generated.bpmn`.
 *
 * Note: Start event (ReviewStart) and end event (Done) have no `name` because
 * the handwritten BPMN gives them no `name` attribute.
 * The conditional branch flow has id `Flow_SeniorBranch` (as named in the
 * handwritten BPMN), not the auto-generated `Flow_AmountCheck_SeniorApproval`
 * that `astToIr` would produce from the DSL source.
 */
const canonicalIr: BpmnProcess = {
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
  xml = await irToXml(canonicalIr);
});

// ── 1. Parses cleanly via bpmn-moddle ────────────────────────────────────────

describe('irToXml — bpmn-moddle round-trip', () => {
  it('irToXml(canonical) parses cleanly via bpmn-moddle.fromXML', async () => {
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
   * for every flow node, matching the edges defined in the canonical IR.
   *
   * This is the reviewer's coverage gap fix: per-node check, not just
   * aggregate totals.
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

// ── 4. Golden diff ──────────────────────────────────────────────────────────

describe('irToXml — golden diff', () => {
  it('output matches the golden generated BPMN file byte-for-byte', () => {
    const goldenXml = readFileSync(GOLDEN_GENERATED_PATH, 'utf-8');
    expect(xml).toBe(goldenXml);
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
