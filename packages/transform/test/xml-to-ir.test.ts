/**
 * Full test suite for the BPMN XML → IR transform.
 *
 * Integration-level tests — they exercise `xmlToIr` against real BPMN
 * XML strings, including the golden fixture files under `tests/golden/`.
 *
 * Test cases:
 *   1. Parsing the canonical handwritten file yields the canonical IR (deep equality).
 *   2. Same file with `camunda:` prefixes instead of `operaton:` → same IR.
 *   3. Service task with `operaton:expression` → `UnsupportedServiceTaskFormError`.
 *   4. XML containing `bpmn:parallelGateway` → successful import (parallelGateway in IR).
 *   4b. Parallel split+join XML (§15.3 shape) → IR with two parallelGateway elements,
 *       6 sequence flows, no conditionExpression on fork-outgoing flows.
 *   4c. Genuinely unsupported element (e.g. `bpmn:scriptTask`) → `UnsupportedElementError`.
 *   5. XML with TWO processes → multi-process error.
 *   6. Bare service task (no discriminator) → `UnsupportedServiceTaskFormError`.
 *   7. DI nodes (`bpmndi:*`, `dc:*`, `di:*`) are dropped from IR (not in flowElements).
 *   8. `<bpmn:incoming>` / `<bpmn:outgoing>` children are dropped from IR.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '../src/xml-to-ir.js';
import {
  UnsupportedElementError,
  UnsupportedServiceTaskFormError,
} from '../src/errors.js';
import type { BpmnProcess } from '../src/ir/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const HANDWRITTEN_PATH = resolve(
  here,
  '../../../tests/golden/invoice-approval-handwritten.bpmn',
);

/**
 * Canonical IR produced by `xmlToIr` from the handwritten BPMN fixture.
 *
 * Note: Start event (ReviewStart) and end event (Done) have no `name` attribute
 * in the handwritten BPMN, so they appear without `name` in the IR.
 * The conditional branch flow uses the name given in the handwritten BPMN
 * (`Flow_SeniorBranch`), not the auto-generated id from `astToIr`.
 * `incoming`/`outgoing` children are dropped from the IR.
 */
const CANONICAL_IR: BpmnProcess = {
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
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
      conditionExpression: '${amount > 1000}',
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

// ── 1. Canonical handwritten file → canonical IR ─────────────────────────────

describe('xmlToIr — canonical handwritten file', () => {
  it('parsing the canonical handwritten file yields the canonical IR (deep equality)', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);
    expect(ir).toEqual(CANONICAL_IR);
  });

  it('process id equals "invoice-approval"', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);
    expect(ir.id).toBe('invoice-approval');
  });

  it('process name equals "Invoice Approval"', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);
    expect(ir.name).toBe('Invoice Approval');
  });

  it('produces 6 flow elements', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);
    expect(ir.flowElements).toHaveLength(6);
  });

  it('produces 6 sequence flows', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);
    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 2. camunda: prefix yields the same IR ───────────────────────────────────

describe('xmlToIr — camunda: prefix alias', () => {
  it('parsing the same file with camunda: prefixes yields the same IR', async () => {
    // Replace `operaton:` with `camunda:` in the XML namespace declaration
    // and all attribute occurrences, simulating a file exported by Camunda 7.
    const operatonXml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const camundaXml = operatonXml
      .replace(
        /xmlns:operaton="http:\/\/operaton\.org\/schema\/1\.0\/bpmn"/g,
        'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
      )
      .replace(/operaton:/g, 'camunda:');

    const ir = await xmlToIr(camundaXml);

    // The IR should be identical — the dual-namespace accept contract.
    expect(ir).toEqual(CANONICAL_IR);
  });

  it('camunda:assignee is read as UserTask.assignee', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="My Task" camunda:assignee="alice" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const ir = await xmlToIr(xml);
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task).toBeDefined();
    if (task?.kind === 'userTask') {
      expect(task.assignee).toBe('alice');
    }
  });
});

// ── 3. operaton:expression raises UnsupportedServiceTaskFormError ─────────────

describe('xmlToIr — unsupported service task form', () => {
  it('service task with operaton:expression raises UnsupportedServiceTaskFormError', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" name="Expr Task" operaton:expression="\${someBean.execute(execution)}" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedServiceTaskFormError,
    );
  });

  it('the UnsupportedServiceTaskFormError names the offending service task id', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="MyExprTask" operaton:expression="\${x}" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="MyExprTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="MyExprTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedServiceTaskFormError);
      expect((err as UnsupportedServiceTaskFormError).serviceTaskId).toBe(
        'MyExprTask',
      );
    }
  });
});

// ── 4. bpmn:parallelGateway is now SUPPORTED (inverted from old "unsupported" test) ──

describe('xmlToIr — parallel gateway support (inverted from old unsupported test)', () => {
  it('XML containing bpmn:parallelGateway is imported successfully (no error)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:parallelGateway id="PG" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="PG" />
    <bpmn:sequenceFlow id="F2" sourceRef="PG" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    // Previously this threw UnsupportedElementError; now it must resolve.
    const ir = await xmlToIr(xml);
    expect(ir.flowElements.some((fe) => fe.kind === 'parallelGateway')).toBe(
      true,
    );
  });

  it('imported parallelGateway carries the correct id', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:parallelGateway id="PG" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="PG" />
    <bpmn:sequenceFlow id="F2" sourceRef="PG" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const ir = await xmlToIr(xml);
    const pg = ir.flowElements.find((fe) => fe.kind === 'parallelGateway');
    expect(pg?.id).toBe('PG');
  });
});

// ── 4b. xmlToIr — parallel split+join (§15.3 shape) ─────────────────────────

describe('xmlToIr — parallel split+join (fork + join)', () => {
  /**
   * §15.3 parallel split+join shape:
   *   Start → Fork (parallelGateway, 2 outgoing)
   *     → BranchA (userTask)
   *     → BranchB (userTask)
   *   BranchA, BranchB → Join (parallelGateway, 2 incoming)
   *   Join → End
   *
   * No conditionExpression on fork-outgoing flows.
   */
  const parallelSplitJoinXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="parallel-proc" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Fork" name="Fork" />
    <bpmn:userTask id="BranchA" name="Branch A" />
    <bpmn:userTask id="BranchB" name="Branch B" />
    <bpmn:parallelGateway id="Join" name="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F_Start_Fork" sourceRef="Start" targetRef="Fork" />
    <bpmn:sequenceFlow id="F_Fork_A" sourceRef="Fork" targetRef="BranchA" />
    <bpmn:sequenceFlow id="F_Fork_B" sourceRef="Fork" targetRef="BranchB" />
    <bpmn:sequenceFlow id="F_A_Join" sourceRef="BranchA" targetRef="Join" />
    <bpmn:sequenceFlow id="F_B_Join" sourceRef="BranchB" targetRef="Join" />
    <bpmn:sequenceFlow id="F_Join_End" sourceRef="Join" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

  it('produces two parallelGateway elements in IR', async () => {
    const ir = await xmlToIr(parallelSplitJoinXml);
    const pgs = ir.flowElements.filter((fe) => fe.kind === 'parallelGateway');
    expect(pgs).toHaveLength(2);
  });

  it('fork parallelGateway has correct id and name', async () => {
    const ir = await xmlToIr(parallelSplitJoinXml);
    const fork = ir.flowElements.find(
      (fe) => fe.kind === 'parallelGateway' && fe.id === 'Fork',
    );
    expect(fork).toBeDefined();
    expect(fork?.name).toBe('Fork');
  });

  it('join parallelGateway has correct id and name', async () => {
    const ir = await xmlToIr(parallelSplitJoinXml);
    const join = ir.flowElements.find(
      (fe) => fe.kind === 'parallelGateway' && fe.id === 'Join',
    );
    expect(join).toBeDefined();
    expect(join?.name).toBe('Join');
  });

  it('produces 6 sequence flows with no conditionExpression on fork-outgoing', async () => {
    const ir = await xmlToIr(parallelSplitJoinXml);
    expect(ir.sequenceFlows).toHaveLength(6);
    // Fork outgoing flows must have no conditionExpression.
    const forkOutgoing = ir.sequenceFlows.filter(
      (f) => f.sourceRef === 'Fork',
    );
    expect(forkOutgoing).toHaveLength(2);
    for (const flow of forkOutgoing) {
      expect(flow.conditionExpression).toBeUndefined();
    }
  });

  it('produces correct full IR for the parallel split+join process', async () => {
    const ir = await xmlToIr(parallelSplitJoinXml);
    expect(ir.id).toBe('parallel-proc');
    expect(ir.flowElements).toHaveLength(6); // Start, Fork, A, B, Join, End
    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 4c. xmlToIr — UnsupportedElementError for genuinely unsupported elements ──

describe('xmlToIr — unsupported element (non-gateway kinds)', () => {
  it('XML containing bpmn:scriptTask raises UnsupportedElementError', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:scriptTask id="ST" name="Script" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ST" />
    <bpmn:sequenceFlow id="F2" sourceRef="ST" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(UnsupportedElementError);
  });
});

// ── 5. Multi-process definitions raise a clear error ────────────────────────

describe('xmlToIr — multi-process error', () => {
  it('XML with two bpmn:process elements raises a clear multi-process error', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p1" isExecutable="true">
    <bpmn:startEvent id="S1" />
    <bpmn:endEvent id="E1" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="E1" />
  </bpmn:process>
  <bpmn:process id="p2" isExecutable="true">
    <bpmn:startEvent id="S2" />
    <bpmn:endEvent id="E2" />
    <bpmn:sequenceFlow id="F2" sourceRef="S2" targetRef="E2" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toThrow(/multi.process|not supported/i);
  });
});

// ── 6. Bare service task (no discriminator) → UnsupportedServiceTaskFormError ─

describe('xmlToIr — bare service task', () => {
  it('service task with no execution discriminator raises UnsupportedServiceTaskFormError', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="BareSvc" name="Bare Service" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="BareSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="BareSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedServiceTaskFormError,
    );
  });

  it('the bare service task error mentions "no execution discriminator"', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="BareSvc" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="BareSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="BareSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedServiceTaskFormError);
      expect((err as UnsupportedServiceTaskFormError).message).toContain(
        'no execution discriminator',
      );
    }
  });
});

// ── 7. DI nodes are dropped from IR ─────────────────────────────────────────

describe('xmlToIr — DI nodes dropped', () => {
  it('bpmndi:*, dc:*, di:* content does not appear in IR flowElements', async () => {
    // The handwritten file has a full <bpmndi:BPMNDiagram> block; none of
    // it should surface in the IR's flowElements array.
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);

    const kinds = ir.flowElements.map((fe) => fe.kind);
    // DI types would surface as something like 'bpmndi:BPMNDiagram'; none
    // of these kinds appear — only the known IR kinds.
    const validKinds = new Set([
      'startEvent',
      'endEvent',
      'userTask',
      'serviceTask',
      'exclusiveGateway',
      'parallelGateway',
    ]);
    for (const k of kinds) {
      expect(validKinds.has(k)).toBe(true);
    }
  });

  it('IR flowElements count is exactly 6 (DI shapes are not counted)', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);

    // The handwritten file has 6 BPMNShapes inside bpmndi: — if DI leaked,
    // we'd get 12 (or more).
    expect(ir.flowElements).toHaveLength(6);
  });
});

// ── 8. incoming/outgoing children are dropped from IR ───────────────────────

describe('xmlToIr — incoming/outgoing children dropped', () => {
  it('IR SequenceFlow objects have no incoming or outgoing arrays', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);

    for (const flow of ir.sequenceFlows) {
      // The SequenceFlow IR type has no `incoming`/`outgoing` fields.
      // Using an `unknown` cast to inspect the runtime object without
      // relying on TypeScript's structural narrowing.
      const flowAny = flow as unknown as Record<string, unknown>;
      expect(flowAny['incoming']).toBeUndefined();
      expect(flowAny['outgoing']).toBeUndefined();
    }
  });

  it('IR FlowElement objects have no incoming or outgoing arrays', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);

    for (const node of ir.flowElements) {
      const nodeAny = node as unknown as Record<string, unknown>;
      expect(nodeAny['incoming']).toBeUndefined();
      expect(nodeAny['outgoing']).toBeUndefined();
    }
  });

  it('sequenceFlows array length matches the number of bpmn:sequenceFlow elements', async () => {
    // 6 sequence flows in the handwritten BPMN.
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const ir = await xmlToIr(xml);

    expect(ir.sequenceFlows).toHaveLength(6);
  });
});
