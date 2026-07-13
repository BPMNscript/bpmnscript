/**
 * Full test suite for the BPMN XML → IR transform.
 *
 * Integration-level tests — they exercise `xmlToIr` against real BPMN
 * XML strings, including the golden fixture files under `tests/golden/`.
 *
 * `xmlToIr` returns `{ ir, warnings }`: `ir` is the process IR,
 * `warnings` reports non-semantic content dropped on import (extra Operaton/
 * camunda extension attributes and elements, lanes). Semantic content the IR
 * cannot express is *refused* — an `UnsupportedConstructError` subclass is
 * thrown before any IR is produced.
 *
 * Test cases:
 *   1. Parsing the canonical handwritten file yields the canonical IR (deep equality)
 *      and an empty `warnings` array (clean input).
 *   2. Same file with `camunda:` prefixes instead of `operaton:` → same IR.
 *   3. Service task with `operaton:expression` → `UnsupportedServiceTaskFormError`.
 *   4. XML containing `bpmn:parallelGateway` → successful import (parallelGateway in IR).
 *   4b. Parallel split+join XML → IR with two parallelGateway elements,
 *       6 sequence flows, no conditionExpression on fork-outgoing flows.
 *   4c. Genuinely unsupported element (e.g. `bpmn:scriptTask`) → `UnsupportedElementError`.
 *   5. XML with TWO processes → multi-process error.
 *   6. Bare service task (no discriminator) → `UnsupportedServiceTaskFormError`.
 *   7. DI nodes (`bpmndi:*`, `dc:*`, `di:*`) are dropped from IR (not in flowElements).
 *   8. `<bpmn:incoming>` / `<bpmn:outgoing>` children are dropped from IR.
 *   9. Refusals: event definitions on a start/end event, loop characteristics on a
 *      task, and multiple linked processes (pools/message flows) each throw the
 *      matching `UnsupportedConstructError` subclass before any IR is produced.
 *  10. Warnings: an unsupported Operaton extension attribute and a lane each surface
 *      one `ImportWarning` naming the concrete dropped construct and its element id.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import {
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedServiceTaskFormError,
  UnsupportedEventDefinitionError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedCollaborationError,
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
 * Note: the process is named "Invoice Approval" in the handwritten BPMN, which
 * is exactly `humanize("invoice-approval")` — so it is treated as derivable and
 * dropped on import (no redundant label in the IR; re-export reproduces it).
 * Start event (ReviewStart) and end event (Done) have no `name` attribute in the
 * handwritten BPMN, so they appear without `name` in the IR. The task/gateway
 * names differ from their humanized ids (casing/hyphen) and are therefore kept.
 * The conditional branch flow uses the name given in the handwritten BPMN
 * (`Flow_SeniorBranch`), not the auto-generated id from `astToIr`.
 * `incoming`/`outgoing` children are dropped from the IR.
 */
const CANONICAL_IR: BpmnProcess = {
  id: 'invoice-approval',
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
    const { ir } = await xmlToIr(xml);
    expect(ir).toEqual(CANONICAL_IR);
  });

  it('clean input produces no warnings', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
  });

  it('process id equals "invoice-approval"', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);
    expect(ir.id).toBe('invoice-approval');
  });

  it('process name is dropped on import when it equals humanize(id)', async () => {
    // The handwritten BPMN names the process "Invoice Approval", which is exactly
    // humanize("invoice-approval"). It is treated as derivable and dropped, so
    // the IR carries no redundant label (re-export reproduces it identically).
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);
    expect(ir.name).toBeUndefined();
  });

  it('produces 6 flow elements', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);
    expect(ir.flowElements).toHaveLength(6);
  });

  it('produces 6 sequence flows', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);
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

    const { ir } = await xmlToIr(camundaXml);

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

    const { ir } = await xmlToIr(xml);
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

// ── 4. bpmn:parallelGateway is supported ─────────────────────────────────────

describe('xmlToIr — parallel gateway support', () => {
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

    const { ir } = await xmlToIr(xml);
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

    const { ir } = await xmlToIr(xml);
    const pg = ir.flowElements.find((fe) => fe.kind === 'parallelGateway');
    expect(pg?.id).toBe('PG');
  });
});

// ── 4b. xmlToIr — parallel split+join ────────────────────────────────────────

describe('xmlToIr — parallel split+join (fork + join)', () => {
  /**
   * Parallel split+join shape:
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
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    const pgs = ir.flowElements.filter((fe) => fe.kind === 'parallelGateway');
    expect(pgs).toHaveLength(2);
  });

  it('fork parallelGateway has correct id and name', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    const fork = ir.flowElements.find(
      (fe) => fe.kind === 'parallelGateway' && fe.id === 'Fork',
    );
    expect(fork).toBeDefined();
    expect(fork?.name).toBe('Fork');
  });

  it('join parallelGateway has correct id and name', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    const join = ir.flowElements.find(
      (fe) => fe.kind === 'parallelGateway' && fe.id === 'Join',
    );
    expect(join).toBeDefined();
    expect(join?.name).toBe('Join');
  });

  it('produces 6 sequence flows with no conditionExpression on fork-outgoing', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
    expect(ir.sequenceFlows).toHaveLength(6);
    // Fork outgoing flows must have no conditionExpression.
    const forkOutgoing = ir.sequenceFlows.filter((f) => f.sourceRef === 'Fork');
    expect(forkOutgoing).toHaveLength(2);
    for (const flow of forkOutgoing) {
      expect(flow.conditionExpression).toBeUndefined();
    }
  });

  it('produces correct full IR for the parallel split+join process', async () => {
    const { ir } = await xmlToIr(parallelSplitJoinXml);
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
    const { ir } = await xmlToIr(xml);

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
    const { ir } = await xmlToIr(xml);

    // The handwritten file has 6 BPMNShapes inside bpmndi: — if DI leaked,
    // we'd get 12 (or more).
    expect(ir.flowElements).toHaveLength(6);
  });
});

// ── 8. incoming/outgoing children are dropped from IR ───────────────────────

describe('xmlToIr — incoming/outgoing children dropped', () => {
  it('IR SequenceFlow objects have no incoming or outgoing arrays', async () => {
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);

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
    const { ir } = await xmlToIr(xml);

    for (const node of ir.flowElements) {
      const nodeAny = node as unknown as Record<string, unknown>;
      expect(nodeAny['incoming']).toBeUndefined();
      expect(nodeAny['outgoing']).toBeUndefined();
    }
  });

  it('sequenceFlows array length matches the number of bpmn:sequenceFlow elements', async () => {
    // 6 sequence flows in the handwritten BPMN.
    const xml = readFileSync(HANDWRITTEN_PATH, 'utf-8');
    const { ir } = await xmlToIr(xml);

    expect(ir.sequenceFlows).toHaveLength(6);
  });
});

// ── 9. Refusals: event definitions on start/end events ──────────────────────

describe('xmlToIr — refuses event definitions on start/end events', () => {
  const timerStartXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="TimerStart">
      <bpmn:timerEventDefinition id="td">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="TimerStart" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  const terminateEndXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="TerminateEnd">
      <bpmn:terminateEventDefinition id="te" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="TerminateEnd" />
  </bpmn:process>
</bpmn:definitions>`;

  it('a start event with a timer definition throws UnsupportedEventDefinitionError', async () => {
    await expect(xmlToIr(timerStartXml)).rejects.toBeInstanceOf(
      UnsupportedEventDefinitionError,
    );
  });

  it('the start-event refusal extends UnsupportedConstructError and names the element + trigger', async () => {
    try {
      await xmlToIr(timerStartXml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      const e = err as UnsupportedEventDefinitionError;
      expect(e.elementId).toBe('TimerStart');
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:TimerEventDefinition');
      expect(e.message).toContain('TimerStart');
    }
  });

  it('an end event with a terminate definition throws UnsupportedEventDefinitionError', async () => {
    await expect(xmlToIr(terminateEndXml)).rejects.toBeInstanceOf(
      UnsupportedEventDefinitionError,
    );
  });

  it('the end-event refusal reports eventKind "end" and extends UnsupportedConstructError', async () => {
    try {
      await xmlToIr(terminateEndXml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      const e = err as UnsupportedEventDefinitionError;
      expect(e.elementId).toBe('TerminateEnd');
      expect(e.eventKind).toBe('end');
      expect(e.definitionType).toBe('bpmn:TerminateEventDefinition');
    }
  });

  it('a plain start event (empty/absent eventDefinitions) is NOT refused', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.flowElements.some((fe) => fe.kind === 'startEvent')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('a plain end event (empty/absent eventDefinitions) is NOT refused', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { ir, warnings } = await xmlToIr(xml);
    expect(ir.flowElements.some((fe) => fe.kind === 'endEvent')).toBe(true);
    expect(warnings).toEqual([]);
  });
});

// ── 9b. Refusals: loop characteristics on tasks ─────────────────────────────

describe('xmlToIr — refuses loop characteristics on tasks', () => {
  const multiInstanceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="LoopTask" name="Loop Task">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false" />
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="LoopTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="LoopTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  const standardLoopXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="RepeatSvc" operaton:class="com.example.Svc">
      <bpmn:standardLoopCharacteristics />
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="RepeatSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="RepeatSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('a user task with multi-instance loop throws UnsupportedLoopCharacteristicsError', async () => {
    await expect(xmlToIr(multiInstanceXml)).rejects.toBeInstanceOf(
      UnsupportedLoopCharacteristicsError,
    );
  });

  it('the multi-instance refusal extends UnsupportedConstructError and names the task', async () => {
    try {
      await xmlToIr(multiInstanceXml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      const e = err as UnsupportedLoopCharacteristicsError;
      expect(e.elementId).toBe('LoopTask');
      expect(e.loopType).toBe('bpmn:MultiInstanceLoopCharacteristics');
      expect(e.message).toContain('LoopTask');
    }
  });

  it('a service task with a standard loop throws UnsupportedLoopCharacteristicsError', async () => {
    await expect(xmlToIr(standardLoopXml)).rejects.toBeInstanceOf(
      UnsupportedLoopCharacteristicsError,
    );
  });

  it('the standard-loop refusal reports the standard-loop loopType', async () => {
    try {
      await xmlToIr(standardLoopXml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedLoopCharacteristicsError);
      const e = err as UnsupportedLoopCharacteristicsError;
      expect(e.elementId).toBe('RepeatSvc');
      expect(e.loopType).toBe('bpmn:StandardLoopCharacteristics');
    }
  });
});

// ── 9c. Refusals: collaboration (pools / message flows) ─────────────────────

describe('xmlToIr — refuses collaborations (pools / message flows)', () => {
  const collaborationXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="Pool1" name="Sales" processRef="p" />
    <bpmn:participant id="Pool2" name="Customer" />
  </bpmn:collaboration>
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('a document containing a bpmn:Collaboration throws UnsupportedCollaborationError', async () => {
    await expect(xmlToIr(collaborationXml)).rejects.toBeInstanceOf(
      UnsupportedCollaborationError,
    );
  });

  it('the collaboration refusal extends UnsupportedConstructError', async () => {
    try {
      await xmlToIr(collaborationXml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      expect(
        (err as UnsupportedCollaborationError).message.length,
      ).toBeGreaterThan(0);
    }
  });
});

// ── 10. Warnings: dropped extension attributes and lanes ────────────────────

describe('xmlToIr — warns for dropped extension attributes', () => {
  const asyncBeforeXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="AsyncTask" name="Async Task"
                   operaton:assignee="alice" operaton:asyncBefore="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('surfaces one warning naming operaton:asyncBefore and the owning element id', async () => {
    const { ir, warnings } = await xmlToIr(asyncBeforeXml);
    // The supported assignee attribute is still read into the IR.
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.kind === 'userTask' && task.assignee).toBe('alice');

    const attrWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'extensionAttribute',
    );
    expect(attrWarnings.length).toBeGreaterThanOrEqual(1);
    const w = attrWarnings.find((w) => w.message.includes('asyncBefore'));
    expect(w).toBeDefined();
    expect(w?.elementId).toBe('AsyncTask');
  });

  it('does NOT warn for the supported assignee/formKey/class attributes', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="T" operaton:assignee="alice" operaton:formKey="form:x" />
    <bpmn:serviceTask id="Svc" operaton:class="com.example.Svc" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="Svc" />
    <bpmn:sequenceFlow id="F3" sourceRef="Svc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
  });

  it('also warns for the deprecated camunda: prefix (dual-namespace)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="T" camunda:candidateGroups="managers" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { warnings } = await xmlToIr(xml);
    const w = warnings.find((w) => w.message.includes('candidateGroups'));
    expect(w).toBeDefined();
    expect(w?.category).toBe('extensionAttribute');
    expect(w?.elementId).toBe('T');
  });

  // `historyTimeToLive` is declared in the moddle extension, so it parses
  // into a typed property (not `$attrs`) and needs the descriptor scan.
  const httlXml = (
    value: string,
  ): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true" operaton:historyTimeToLive="${value}">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('warns when a custom operaton:historyTimeToLive would be lost', async () => {
    const { warnings } = await xmlToIr(httlXml('P90D'));
    const httlWarnings = warnings.filter((w) =>
      w.message.includes('operaton:historyTimeToLive'),
    );
    expect(httlWarnings).toHaveLength(1);
    expect(httlWarnings[0].category).toBe('extensionAttribute');
    expect(httlWarnings[0].elementId).toBe('p');
  });

  it('stays silent for the value the exporter re-stamps (P30D)', async () => {
    const { warnings } = await xmlToIr(httlXml('P30D'));
    expect(warnings).toEqual([]);
  });
});

describe('xmlToIr — warns for dropped lanes', () => {
  const lanesXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Sales" name="Sales">
        <bpmn:flowNodeRef>S</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Support" name="Support">
        <bpmn:flowNodeRef>E</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('surfaces one lane warning per lane, naming the lane and its element id', async () => {
    const { warnings } = await xmlToIr(lanesXml);
    const laneWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'lane',
    );
    expect(laneWarnings).toHaveLength(2);

    const sales = laneWarnings.find((w) => w.elementId === 'Lane_Sales');
    expect(sales).toBeDefined();
    expect(sales?.message).toContain('Sales');

    const support = laneWarnings.find((w) => w.elementId === 'Lane_Support');
    expect(support).toBeDefined();
  });

  it('still imports the process body when lanes are present', async () => {
    const { ir } = await xmlToIr(lanesXml);
    expect(ir.flowElements.some((fe) => fe.kind === 'startEvent')).toBe(true);
    expect(ir.flowElements.some((fe) => fe.kind === 'endEvent')).toBe(true);
  });
});

// ── 11. Warnings: dropped extension elements ────────────────────────────────

describe('xmlToIr — warns for dropped extension elements', () => {
  it('warns (owner id) when a task carries engine-specific extension elements', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ConfiguredSvc" operaton:class="com.example.Svc">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="ConfiguredSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { warnings } = await xmlToIr(xml);
    const w = warnings.find(
      (w) =>
        w.category === 'extensionAttribute' && w.elementId === 'ConfiguredSvc',
    );
    expect(w).toBeDefined();
  });

  it('names the concrete extension-element type in the warning message', async () => {
    // `operaton:inputOutput` is typed in the moddle extension, so it
    // materialises as a `values` entry and the message names it precisely.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ConfiguredSvc" operaton:class="com.example.Svc">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="ConfiguredSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { warnings } = await xmlToIr(xml);
    const w = warnings.find((w) => w.elementId === 'ConfiguredSvc');
    expect(w?.message).toMatch(/InputOutput/i);
  });
});

// ── 11b. Regression: a clean empty <extensionElements/> is not flagged
// when another element in the same document carries a real drop. ────────────

describe('xmlToIr — empty extensionElements is not flagged (regression)', () => {
  /**
   * One document, two elements: a user task with a genuinely empty
   * `<bpmn:extensionElements/>` (a stray stub modelers leave behind) and a
   * service task with a real `<operaton:inputOutput>` block. A single
   * document-level "unparsable content" boolean cannot tell the two apart
   * and would flag both; typing the operaton extension elements makes the
   * drop attributable to the exact owning element, so exactly one warning
   * must fire, on the element that really drops content.
   */
  const twoElementXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task" operaton:assignee="alice">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:serviceTask id="ConfiguredSvc" operaton:class="com.example.Svc">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="ConfiguredSvc" />
    <bpmn:sequenceFlow id="F3" sourceRef="ConfiguredSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('emits exactly one extension warning, attributed to the real element only', async () => {
    const { warnings } = await xmlToIr(twoElementXml);
    const extWarnings = warnings.filter(
      (w) => w.category === 'extensionAttribute',
    );
    expect(extWarnings).toHaveLength(1);
    expect(extWarnings[0].elementId).toBe('ConfiguredSvc');
  });

  it('does not attribute any warning to the element with an empty extensionElements', async () => {
    const { warnings } = await xmlToIr(twoElementXml);
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
  });

  it('still reads the supported assignee off the clean task', async () => {
    const { ir } = await xmlToIr(twoElementXml);
    const clean = ir.flowElements.find((fe) => fe.id === 'CleanTask');
    expect(clean?.kind === 'userTask' && clean.assignee).toBe('alice');
  });
});

// ── 11c. Foreign-namespace (camunda:) extension elements are attributed
// precisely per element (moddle keeps them as generic values). ──────────────

describe('xmlToIr — foreign-namespace extension elements are per-element', () => {
  it('names a camunda: extension element against its owning task', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="CamSvc" name="Cam Svc">
      <bpmn:extensionElements>
        <camunda:connector>
          <camunda:connectorId>http-connector</camunda:connectorId>
        </camunda:connector>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CamSvc" />
    <bpmn:sequenceFlow id="F2" sourceRef="CamSvc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    // Give the service task a supported form so mapping does not refuse first.
    const withClass = xml.replace(
      'id="CamSvc" name="Cam Svc"',
      'id="CamSvc" name="Cam Svc" camunda:class="com.example.Svc"',
    );
    const { warnings } = await xmlToIr(withClass);
    const w = warnings.find((w) => w.elementId === 'CamSvc');
    expect(w).toBeDefined();
    expect(w?.category).toBe('extensionAttribute');
  });
});

// ── 11d. Undeclared operaton:* extension elements are reported once, not lost
// and not fanned out across clean elements. ─────────────────────────────────

describe('xmlToIr — undeclared operaton extension element residual', () => {
  const residualXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="CleanTask" name="Clean Task">
      <bpmn:extensionElements/>
    </bpmn:userTask>
    <bpmn:userTask id="PropsTask" name="Props Task">
      <bpmn:extensionElements>
        <operaton:properties>
          <operaton:property name="k" value="v" />
        </operaton:properties>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CleanTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="CleanTask" targetRef="PropsTask" />
    <bpmn:sequenceFlow id="F3" sourceRef="PropsTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('reports the undeclared element once (no silent loss) without flagging the clean task', async () => {
    const { warnings } = await xmlToIr(residualXml);
    const extWarnings = warnings.filter(
      (w) => w.category === 'extensionAttribute',
    );
    // Exactly one warning for the one real drop.
    expect(extWarnings).toHaveLength(1);
    // The clean empty stub is never flagged.
    expect(warnings.some((w) => w.elementId === 'CleanTask')).toBe(false);
    // The concrete construct is named in the message.
    expect(extWarnings[0].message).toMatch(/properties/i);
    // Attributed to the process id — the documented coarse attribution for
    // residual drops moddle cannot tie to a specific step.
    expect(extWarnings[0].elementId).toBe('p');
  });
});
