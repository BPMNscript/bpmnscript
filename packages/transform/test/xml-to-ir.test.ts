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
 *   3. Service task execution forms — `operaton:expression`,
 *       `operaton:delegateExpression`, and `operaton:type="external"` + topic —
 *       import to the matching `serviceTask` binding.
 *   4. XML containing `bpmn:parallelGateway` → successful import (parallelGateway in IR).
 *   4b. Parallel split+join XML → IR with two parallelGateway elements,
 *       6 sequence flows, no conditionExpression on fork-outgoing flows.
 *   4c. `bpmn:scriptTask` → `scriptTask` IR; a genuinely unsupported kind
 *       (`bpmn:transaction`, `bpmn:adHocSubProcess`) → `UnsupportedElementError`.
 *   5. XML with TWO processes → multi-process error.
 *   6. Bare service task (no discriminator) → `UnsupportedServiceTaskFormError`.
 *   7. DI nodes (`bpmndi:*`, `dc:*`, `di:*`) are dropped from IR (not in flowElements).
 *   8. `<bpmn:incoming>` / `<bpmn:outgoing>` children are dropped from IR.
 *   9. Refusals: event definitions on a start/end event, loop characteristics on a
 *      task, and multiple linked processes (pools/message flows) each throw the
 *      matching `UnsupportedConstructError` subclass before any IR is produced.
 *  10. Warnings: an unsupported Operaton extension attribute and a lane each surface
 *      one `ImportWarning` naming the concrete dropped construct and its element id.
 *  11. Warnings: dropped extension elements — a declared `operaton:` element
 *      (11), a clean empty `<extensionElements/>` stays silent even alongside
 *      a real drop elsewhere (11b), a foreign-namespace `camunda:` element is
 *      attributed to its owner (11c), and an undeclared `operaton:` element
 *      moddle cannot pin to a step is reported once against the process (11d).
 *  12. `bpmn:subProcess` imports recursively into an IR `SubProcess` (nested
 *      body in its own `flowElements`/`sequenceFlows`, nothing leaked to the
 *      parent); an event sub-process (`triggeredByEvent="true"`) and loop
 *      characteristics on a sub-process are refused; an extension attribute
 *      on a task nested inside a sub-process and an event definition on a
 *      nested start event are handled exactly as at the top level;
 *      two-level nesting imports recursively.
 *  13. `bpmn:callActivity` imports `calledElement`, binding, business key,
 *      and in/out mappings — the exact shape the export side produces — into
 *      the matching `callActivity` IR node (deep equality, document order,
 *      `local` flags). The binding table (absent/`latest`/`deployment`/
 *      `version`, the `camunda:` alias, refusals for a versionless `version`
 *      binding and an unrecognized binding value, and the dangling-
 *      `calledElementVersion` warning). Mapping-shape refusals (one per
 *      malformed combination). The `operaton:in`/`operaton:out` honesty
 *      guard: still a drop on any other element, still a drop for the
 *      foreign `camunda:` alias on a call activity, silent on a clean
 *      import. Nesting inside a sub-process; loop characteristics refused;
 *      `readDerivableName` symmetry.
 *  14. Event layer import (the `on`/`throw`/`emit` counterpart): an event
 *      handler (`triggeredByEvent="true"`), a typed end event, and an
 *      escalation intermediate throw import to the matching IR shapes,
 *      sharing one root per code; catch-all definitions (no ref, or a ref to
 *      a code-less root) import with the code absent. Refusals: a
 *      non-error/escalation trigger on a handler start (a terminate
 *      definition), a handler with the wrong start-event/definition count or
 *      with incoming/outgoing flows, a non-interrupting error handler, a
 *      throw/emit resolving to no code, an error definition on an emit, a
 *      "none" emit, and disagreeing or unkeyable declared root messages.
 *      Warn-drops: a genuine label on a handler/throw, a throw-side binding
 *      attribute, an unrelated `operaton:` attribute on a mapped event
 *      definition, and an unreferenced message-less root (a declared,
 *      unreferenced root with a message imports silently into
 *      `errorMessages`). A handler nested inside a plain sub-process; a
 *      defined normal start event still refuses; `bpmn:IntermediateCatchEvent`
 *      is imported, not refused (flip documented here, full coverage in
 *      section 18 below).
 *  15. Message/signal/timer/conditional import: a message handler, a
 *      non-interrupting signal handler, a duration timer handler, a date
 *      timer handler, a conditional handler, and a signal end event/emit
 *      sharing one root all import to the matching IR shapes, `warnings: []`
 *      (deep equality). Refusals: a ref-less message definition; a signal
 *      ref to a nameless root; a timer with zero or with two time children;
 *      a timer with an empty body; a conditional with no condition child;
 *      `operaton:variableName`/`camunda:variableEvents` on a conditional
 *      definition; a message definition on an end event; a conditional
 *      definition on an intermediate throw. Root honesty: two same-named
 *      `bpmn:Signal` roots, both referenced, collapse to one IR name with no
 *      warning; an unreferenced `bpmn:Message` root warns once; a referenced
 *      message root's `itemRef` warns once and still imports. `camunda:`
 *      parity: `camunda:variableName` refuses the same way, and a clean
 *      `camunda:`-free conditional handler is not false-refused. A timer
 *      handler nested inside a plain sub-process imports into the nested
 *      container.
 *  16. Compensation import: a compensation handler (hosted by the plain
 *      sub-process it compensates), a compensation intermediate throw, and a
 *      compensation end event import to `{ kind: 'compensation' }` (no
 *      code, no `activityRef`), `warnings: []`; an explicit
 *      `waitForCompletion="true"` on both throw positions imports
 *      identically to the default (absent) form. Refusals (one per shape):
 *      `activityRef` on a handler-start/end-event compensate definition;
 *      `waitForCompletion="false"` on an intermediate throw/end event; a
 *      non-interrupting compensation handler; a compensation event
 *      sub-process hosted directly by the process, or by another event
 *      sub-process, instead of the plain sub-process it compensates;
 *      `isForCompensation="true"` on a service task and on a sub-process;
 *      a compensation `bpmn:BoundaryEvent` still refuses, now with
 *      `UnsupportedEventFeatureError` naming the sub-process undo block
 *      instead. The six prior definition kinds (error, escalation, message,
 *      signal, timer, conditional) still import unchanged; a compensation
 *      handler nested inside a plain sub-process that is itself nested
 *      inside another plain sub-process imports into the correct (deepest)
 *      container.
 *  17. Boundary event import: each of the six supported triggers imports a
 *      `bpmn:BoundaryEvent` into a `boundaryEvent` IR node with the right
 *      `attachedToRef`; `cancelActivity="false"` imports as
 *      `cancelActivity: false` and is absent otherwise; a boundary event on
 *      a host nested inside a sub-process imports at that depth; a
 *      warning-free import produces zero `ImportWarning`s. Refusals (one per
 *      shape): no `attachedToRef`; an incoming sequence flow; an
 *      `operaton:inputOutput` mapping; a trigger definition kind outside the
 *      six (`UnsupportedEventDefinitionError`, naming the boundary
 *      position); `cancelActivity="false"` together with an error trigger;
 *      an escalation trigger attached to a service or script task; and an
 *      `attachedToRef` naming an activity that lives in a different
 *      container.
 *  18. Intermediate catch event import (the `await` counterpart): each of
 *      the four supported triggers (message, timer — all three kinds —,
 *      signal, conditional) imports a `bpmn:IntermediateCatchEvent` into an
 *      `intermediateCatchEvent` IR node on the main flow, incoming and
 *      outgoing sequence flows preserved. Refusals: a link, error,
 *      escalation, compensation, or cancel definition, each naming the
 *      unsupported form in `.detail`; two event definitions on one catch;
 *      `parallelMultiple="true"`; a conditional catch carrying an
 *      evaluation-narrowing `operaton:variableName` attribute (inherited
 *      from `readCatchEventDefinition`, pinned here explicitly).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '../src/xml-to-ir.js';
import type { ImportWarning } from '../src/xml-to-ir.js';
import {
  UnsupportedCallActivityError,
  UnsupportedCollaborationError,
  UnsupportedConstructError,
  UnsupportedElementError,
  UnsupportedEventDefinitionError,
  UnsupportedEventFeatureError,
  UnsupportedLoopCharacteristicsError,
  UnsupportedServiceTaskFormError,
} from '../src/errors.js';
import type { BpmnProcess, CallActivity } from '../src/ir/types.js';

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

// ── 3. Service task execution forms import to their bindings ─────────────────

describe('xmlToIr — service task expression binding', () => {
  it('operaton:expression imports to an expression binding carrying the raw text', async () => {
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

    const { ir } = await xmlToIr(xml);
    const svc = ir.flowElements.find((fe) => fe.id === 'T');
    expect(svc?.kind).toBe('serviceTask');
    if (svc?.kind === 'serviceTask') {
      expect(svc.binding).toEqual({
        kind: 'expression',
        expression: '${someBean.execute(execution)}',
      });
    }
  });

  it('the camunda: prefix is accepted for the expression form', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" camunda:expression="\${x}" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const svc = ir.flowElements.find((fe) => fe.id === 'T');
    expect(svc?.kind === 'serviceTask' && svc.binding.kind).toBe('expression');
  });
});

describe('xmlToIr — service task delegateExpression binding', () => {
  it('operaton:delegateExpression imports to a delegateExpression binding', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" name="Delegate Task" operaton:delegateExpression="\${myDelegate}" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const svc = ir.flowElements.find((fe) => fe.id === 'T');
    expect(svc?.kind).toBe('serviceTask');
    if (svc?.kind === 'serviceTask') {
      expect(svc.binding).toEqual({
        kind: 'delegateExpression',
        expression: '${myDelegate}',
      });
    }
  });
});

describe('xmlToIr — external task binding', () => {
  it('operaton:type="external" with a topic imports to an external binding', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" name="Ship It" operaton:type="external" operaton:topic="shipping" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const svc = ir.flowElements.find((fe) => fe.id === 'T');
    expect(svc?.kind).toBe('serviceTask');
    if (svc?.kind === 'serviceTask') {
      expect(svc.binding).toEqual({ kind: 'external', topic: 'shipping' });
    }
  });

  it('an accepted external task produces no drop warnings for type/topic', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" operaton:type="external" operaton:topic="shipping" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
  });

  it('operaton:type="external" WITHOUT a topic stays refused', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="T" operaton:type="external" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedServiceTaskFormError,
    );
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

// ── 4c. xmlToIr — script task imports to a scriptTask IR ─────────────────────

describe('xmlToIr — script task support', () => {
  it('bpmn:scriptTask imports to a scriptTask IR carrying scriptFormat and body', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:scriptTask id="ST" name="Compute total" scriptFormat="javascript">
      <bpmn:script>total = price * quantity;</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ST" />
    <bpmn:sequenceFlow id="F2" sourceRef="ST" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const script = ir.flowElements.find((fe) => fe.id === 'ST');
    expect(script?.kind).toBe('scriptTask');
    if (script?.kind === 'scriptTask') {
      expect(script.format).toBe('javascript');
      expect(script.code).toBe('total = price * quantity;');
      expect(script.name).toBe('Compute total');
    }
  });

  it('decodes an entity-escaped bpmn:script body to the literal text', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:scriptTask id="ST" scriptFormat="javascript">
      <bpmn:script>a &lt; b &amp;&amp; c</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ST" />
    <bpmn:sequenceFlow id="F2" sourceRef="ST" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const script = ir.flowElements.find((fe) => fe.id === 'ST');
    expect(script?.kind).toBe('scriptTask');
    if (script?.kind === 'scriptTask') {
      expect(script.code).toBe('a < b && c');
    }
  });
});

// ── 4d. xmlToIr — UnsupportedElementError for genuinely unsupported kinds ─────

describe('xmlToIr — unsupported element (still refused kinds)', () => {
  it('bpmn:transaction raises UnsupportedElementError', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:transaction id="Tx">
      <bpmn:startEvent id="TxStart" />
      <bpmn:endEvent id="TxEnd" />
      <bpmn:sequenceFlow id="TxF" sourceRef="TxStart" targetRef="TxEnd" />
    </bpmn:transaction>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Tx" />
    <bpmn:sequenceFlow id="F2" sourceRef="Tx" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(UnsupportedElementError);
  });

  it('bpmn:adHocSubProcess raises UnsupportedElementError', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:adHocSubProcess id="AdHoc">
      <bpmn:userTask id="A" />
    </bpmn:adHocSubProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AdHoc" />
    <bpmn:sequenceFlow id="F2" sourceRef="AdHoc" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(UnsupportedElementError);
  });

  it('bpmn:callActivity is imported, not refused (see the "callActivity import" suite below)', async () => {
    // The pinned refusal for `bpmn:callActivity` is superseded by a positive
    // import contract — see "xmlToIr — callActivity import" below for full
    // coverage. This assertion documents the flip: a well-formed call
    // activity no longer raises UnsupportedElementError.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:callActivity id="Call" calledElement="other-process" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Call" />
    <bpmn:sequenceFlow id="F2" sourceRef="Call" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    expect(ir.flowElements.some((fe) => fe.kind === 'callActivity')).toBe(true);
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

// ── 11e. bpmn:documentation is warned-and-dropped, per owning element ───────

describe('xmlToIr — warns for dropped documentation', () => {
  const documentationXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:documentation>This process handles onboarding.</bpmn:documentation>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="DocTask" name="Review the application" operaton:assignee="alice">
      <bpmn:documentation>Collect the signed form.</bpmn:documentation>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="DocTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="DocTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  it('surfaces one documentation warning per owning element (process and task)', async () => {
    const { warnings } = await xmlToIr(documentationXml);
    const docWarnings = warnings.filter(
      (w: ImportWarning) => w.category === 'documentation',
    );
    expect(docWarnings).toHaveLength(2);

    const processWarning = docWarnings.find((w) => w.elementId === 'p');
    expect(processWarning).toBeDefined();
    expect(processWarning?.message).toMatch(/documentation/i);

    const taskWarning = docWarnings.find((w) => w.elementId === 'DocTask');
    expect(taskWarning).toBeDefined();
    expect(taskWarning?.message).toMatch(/documentation/i);
  });

  it('still imports the process body when documentation is present', async () => {
    const { ir } = await xmlToIr(documentationXml);
    expect(ir.flowElements.some((fe) => fe.kind === 'startEvent')).toBe(true);
    const task = ir.flowElements.find((fe) => fe.id === 'DocTask');
    expect(task?.kind === 'userTask' && task.name).toBe(
      'Review the application',
    );
    expect(task?.kind === 'userTask' && task.assignee).toBe('alice');
  });

  it('does NOT warn when no element carries documentation (no false positives)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="T" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;
    const { warnings } = await xmlToIr(xml);
    expect(warnings.some((w) => w.category === 'documentation')).toBe(false);
  });
});

// ── 12. Embedded bpmn:subProcess imports recursively ─────────────────────────

describe('xmlToIr — embedded sub-process imports recursively', () => {
  const nestedSubProcessXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Sub" name="Sub Process">
      <bpmn:startEvent id="SubStart" />
      <bpmn:userTask id="Review" name="Review" operaton:assignee="demo" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="Review" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Review" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

  it('maps to a recursive IR SubProcess carrying its own nested body', async () => {
    const { ir, warnings } = await xmlToIr(nestedSubProcessXml);
    expect(warnings).toEqual([]);

    const sub = ir.flowElements.find((fe) => fe.id === 'Sub');
    expect(sub?.kind).toBe('subProcess');
    if (sub?.kind !== 'subProcess') return;

    expect(sub.name).toBe('Sub Process');
    expect(sub.flowElements.map((fe) => fe.id)).toEqual([
      'SubStart',
      'Review',
      'SubEnd',
    ]);
    expect(sub.sequenceFlows.map((f) => f.id)).toEqual(['SF1', 'SF2']);
    const review = sub.flowElements.find((fe) => fe.id === 'Review');
    expect(review?.kind === 'userTask' && review.assignee).toBe('demo');
  });

  it('drops a sub-process name that exactly equals humanize(id)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub" name="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const sub = ir.flowElements.find((fe) => fe.id === 'Sub');
    expect(sub?.kind).toBe('subProcess');
    expect(sub && 'name' in sub).toBe(false);
  });

  it('leaks nothing from the nested body into the parent container', async () => {
    const { ir } = await xmlToIr(nestedSubProcessXml);
    expect(ir.flowElements.map((fe) => fe.id)).toEqual([
      'PStart',
      'Sub',
      'PEnd',
    ]);
    expect(ir.sequenceFlows.map((f) => f.id)).toEqual(['F1', 'F2']);
  });

  it('an event sub-process (triggeredByEvent="true") is imported, not refused — see the "event layer import" suite below', async () => {
    // The pinned refusal for `triggeredByEvent="true"` is superseded by a
    // positive import contract — see "xmlToIr — event layer import" below
    // for full coverage of the map/refuse/warn taxonomy. This assertion
    // documents the flip: a well-formed event handler no longer raises
    // UnsupportedElementError.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_PF" errorCode="PF" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub" triggeredByEvent="true">
      <bpmn:startEvent id="SubStart">
        <bpmn:errorEventDefinition id="SubStartDef" errorRef="Error_PF" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    expect(
      ir.flowElements.some(
        (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
      ),
    ).toBe(true);
  });

  it('refuses a sub-process with multiInstanceLoopCharacteristics', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false" />
      <bpmn:startEvent id="SubStart" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedLoopCharacteristicsError,
    );
  });

  it('warns for an unsupported extension attribute on a task nested inside a sub-process', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:userTask id="InnerTask" name="Inner Task"
                     operaton:assignee="alice" operaton:asyncBefore="true" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="InnerTask" />
      <bpmn:sequenceFlow id="SF2" sourceRef="InnerTask" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    const w = warnings.find((w) => w.message.includes('asyncBefore'));
    expect(w).toBeDefined();
    expect(w?.elementId).toBe('InnerTask');
  });

  it('refuses an event definition on a start event nested inside a sub-process', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart">
        <bpmn:timerEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedEventDefinitionError,
    );
  });

  it('imports two-level nesting recursively', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:subProcess id="Inner">
        <bpmn:startEvent id="IStart" />
        <bpmn:userTask id="Deep" />
        <bpmn:endEvent id="IEnd" />
        <bpmn:sequenceFlow id="SF_IStart_Deep" sourceRef="IStart" targetRef="Deep" />
        <bpmn:sequenceFlow id="SF_Deep_IEnd" sourceRef="Deep" targetRef="IEnd" />
      </bpmn:subProcess>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="SF_OStart_Inner" sourceRef="OStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="SF_Inner_OEnd" sourceRef="Inner" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    const outer = ir.flowElements.find((fe) => fe.id === 'Outer');
    expect(outer?.kind).toBe('subProcess');
    if (outer?.kind !== 'subProcess') return;

    const inner = outer.flowElements.find((fe) => fe.id === 'Inner');
    expect(inner?.kind).toBe('subProcess');
    if (inner?.kind !== 'subProcess') return;

    expect(inner.flowElements.map((fe) => fe.id)).toEqual([
      'IStart',
      'Deep',
      'IEnd',
    ]);
    expect(outer.flowElements.map((fe) => fe.id)).toEqual([
      'OStart',
      'Inner',
      'OEnd',
    ]);
  });
});

// ── 13. callActivity import ──────────────────────────────────────────────────

describe('xmlToIr — callActivity import', () => {
  const richCallXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="CallSub" name="Call sub" calledElement="sub-process"
                       operaton:calledElementBinding="version" operaton:calledElementVersion="3">
      <bpmn:extensionElements>
        <operaton:in businessKey="\${execution.processBusinessKey}" />
        <operaton:in variables="all" />
        <operaton:in source="amount" target="amount" />
        <operaton:in sourceExpression="\${total * 2}" target="doubled" local="true" />
        <operaton:out source="result" target="outcome" />
        <operaton:out sourceExpression="\${status}" target="final" />
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="CallSub" />
    <bpmn:sequenceFlow id="F2" sourceRef="CallSub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

  const EXPECTED_RICH_CALL: CallActivity = {
    kind: 'callActivity',
    id: 'CallSub',
    name: 'Call sub',
    calledElement: 'sub-process',
    binding: { kind: 'version', version: '3' },
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
  };

  it('a fully-featured call activity imports to the exact expected IR node (deep equality)', async () => {
    const { ir } = await xmlToIr(richCallXml);
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call).toEqual(EXPECTED_RICH_CALL);
  });

  // ── Binding table ───────────────────────────────────────────────────────

  const callXmlWithBindingAttrs = (
    attrs: string,
  ): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="CallSub" calledElement="sub-process" ${attrs} />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="CallSub" />
    <bpmn:sequenceFlow id="F2" sourceRef="CallSub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

  it('no binding attributes → the IR binding is absent', async () => {
    const { ir } = await xmlToIr(callXmlWithBindingAttrs(''));
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call && 'binding' in call).toBe(false);
  });

  it('calledElementBinding="latest" → { kind: "latest" }', async () => {
    const { ir } = await xmlToIr(
      callXmlWithBindingAttrs('operaton:calledElementBinding="latest"'),
    );
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call?.kind === 'callActivity' && call.binding).toEqual({
      kind: 'latest',
    });
  });

  it('calledElementBinding="deployment" → { kind: "deployment" }', async () => {
    const { ir } = await xmlToIr(
      callXmlWithBindingAttrs('operaton:calledElementBinding="deployment"'),
    );
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call?.kind === 'callActivity' && call.binding).toEqual({
      kind: 'deployment',
    });
  });

  it('calledElementBinding="version" with calledElementVersion → { kind: "version", version }', async () => {
    const { ir } = await xmlToIr(
      callXmlWithBindingAttrs(
        'operaton:calledElementBinding="version" operaton:calledElementVersion="7"',
      ),
    );
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call?.kind === 'callActivity' && call.binding).toEqual({
      kind: 'version',
      version: '7',
    });
  });

  it('camunda:calledElementBinding is honored, matching the assignee dual-namespace contract', async () => {
    const { ir } = await xmlToIr(
      callXmlWithBindingAttrs('camunda:calledElementBinding="latest"'),
    );
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call?.kind === 'callActivity' && call.binding).toEqual({
      kind: 'latest',
    });
  });

  it('calledElementBinding="version" WITHOUT a version is refused', async () => {
    await expect(
      xmlToIr(
        callXmlWithBindingAttrs('operaton:calledElementBinding="version"'),
      ),
    ).rejects.toBeInstanceOf(UnsupportedCallActivityError);
  });

  it('an unrecognized calledElementBinding value (e.g. versionTag) is refused', async () => {
    await expect(
      xmlToIr(
        callXmlWithBindingAttrs('operaton:calledElementBinding="versionTag"'),
      ),
    ).rejects.toBeInstanceOf(UnsupportedCallActivityError);
  });

  it('a dangling calledElementVersion (binding absent) imports with NO binding and exactly one warning', async () => {
    const { ir, warnings } = await xmlToIr(
      callXmlWithBindingAttrs('operaton:calledElementVersion="7"'),
    );
    const call = ir.flowElements.find((fe) => fe.id === 'CallSub');
    expect(call && 'binding' in call).toBe(false);

    const versionWarnings = warnings.filter((w) =>
      w.message.includes('calledElementVersion'),
    );
    expect(versionWarnings).toHaveLength(1);
    expect(versionWarnings[0].elementId).toBe('CallSub');
  });

  // ── Execution-affecting extension attributes ─────────────────────────────

  it('operaton:variableMappingClass is refused, naming the variable-mapping attribute', async () => {
    try {
      await xmlToIr(
        callXmlWithBindingAttrs(
          'operaton:variableMappingClass="com.acme.Mapper"',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /variableMappingClass/,
      );
    }
  });

  it('operaton:variableMappingDelegateExpression is refused, naming the variable-mapping attribute', async () => {
    try {
      await xmlToIr(
        callXmlWithBindingAttrs(
          'operaton:variableMappingDelegateExpression="${mapper}"',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /variableMappingDelegateExpression/,
      );
    }
  });

  it('operaton:calledElementTenantId is refused, naming the tenant attribute', async () => {
    try {
      await xmlToIr(
        callXmlWithBindingAttrs('operaton:calledElementTenantId="tenant-a"'),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /calledElementTenantId/,
      );
    }
  });

  it('camunda:calledElementTenantId is refused too, matching the dual-namespace contract', async () => {
    try {
      await xmlToIr(
        callXmlWithBindingAttrs('camunda:calledElementTenantId="tenant-a"'),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /calledElementTenantId/,
      );
    }
  });

  it('a call activity with one of these attributes throws instead of importing with a warning', async () => {
    const result = xmlToIr(
      callXmlWithBindingAttrs(
        'operaton:variableMappingClass="com.acme.Mapper"',
      ),
    );
    // Previously this attribute was a warn-drop and the promise resolved
    // with { ir, warnings }; it must now reject instead.
    await expect(result).rejects.toBeInstanceOf(UnsupportedCallActivityError);
  });

  // ── Mapping-shape refusals ────────────────────────────────────────────────

  const callXmlWithExtension = (
    extension: string,
  ): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="CallSub" calledElement="sub-process">
      <bpmn:extensionElements>
        ${extension}
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="CallSub" />
    <bpmn:sequenceFlow id="F2" sourceRef="CallSub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

  it('an operaton:in with both source and sourceExpression is refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension(
          '<operaton:in source="a" sourceExpression="${b}" target="c" />',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /source.*sourceExpression/i,
      );
    }
  });

  it('an operaton:in with source but no target is refused, naming the shape', async () => {
    try {
      await xmlToIr(callXmlWithExtension('<operaton:in source="a" />'));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /source without a target/i,
      );
    }
  });

  it('an operaton:in with variables="foo" is refused, naming the shape', async () => {
    try {
      await xmlToIr(callXmlWithExtension('<operaton:in variables="foo" />'));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /variables="foo"/,
      );
    }
  });

  it('a businessKey In combined with a target is refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension(
          '<operaton:in businessKey="${execution.processBusinessKey}" target="x" />',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /businessKey/i,
      );
    }
  });

  it('two businessKey Ins are refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension(
          '<operaton:in businessKey="${a}" /><operaton:in businessKey="${b}" />',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /more than one/i,
      );
    }
  });

  it('an empty operaton:in with no recognized attribute is refused', async () => {
    try {
      await xmlToIr(callXmlWithExtension('<operaton:in />'));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /none of the recognized shapes/i,
      );
    }
  });

  it('an operaton:in with sourceExpression but no target is refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension('<operaton:in sourceExpression="${a}" />'),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /sourceExpression without a target/i,
      );
    }
  });

  it('an operaton:in with variables="all" combined with source/target is refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension(
          '<operaton:in variables="all" source="a" target="b" />',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /variables="all" combined with/i,
      );
    }
  });

  it('a businessKey In combined with variables is refused, naming the shape', async () => {
    try {
      await xmlToIr(
        callXmlWithExtension(
          '<operaton:in businessKey="${a}" variables="all" />',
        ),
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCallActivityError);
      expect((err as UnsupportedCallActivityError).detail).toMatch(
        /businessKey.*variables/i,
      );
    }
  });

  // ── The operaton:in/operaton:out honesty guard ───────────────────────────

  it('an operaton:in inside a user task still produces one drop warning attributed to that task', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" name="T" operaton:assignee="alice">
      <bpmn:extensionElements>
        <operaton:in source="a" target="b" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    const extWarnings = warnings.filter(
      (w) => w.category === 'extensionAttribute' && w.elementId === 'T',
    );
    expect(extWarnings).toHaveLength(1);
  });

  it('a camunda:in on a call activity produces a drop warning (foreign-namespace element)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="CallSub" calledElement="sub-process">
      <bpmn:extensionElements>
        <camunda:in source="a" target="b" />
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="CallSub" />
    <bpmn:sequenceFlow id="F2" sourceRef="CallSub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    const w = warnings.find(
      (w) => w.category === 'extensionAttribute' && w.elementId === 'CallSub',
    );
    expect(w).toBeDefined();
  });

  it('a clean call-activity import produces no warnings', async () => {
    const { warnings } = await xmlToIr(richCallXml);
    expect(warnings).toEqual([]);
  });

  // ── Nesting and loop characteristics ─────────────────────────────────────

  it('a call activity inside a sub-process imports into the nested container', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:callActivity id="InnerCall" calledElement="sub-process" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="SubStart" targetRef="InnerCall" />
      <bpmn:sequenceFlow id="SF2" sourceRef="InnerCall" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Sub" />
    <bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const sub = ir.flowElements.find((fe) => fe.id === 'Sub');
    expect(sub?.kind).toBe('subProcess');
    if (sub?.kind !== 'subProcess') return;

    const inner = sub.flowElements.find((fe) => fe.id === 'InnerCall');
    expect(inner?.kind).toBe('callActivity');
    expect(inner?.kind === 'callActivity' && inner.calledElement).toBe(
      'sub-process',
    );
  });

  it('a call activity with multiInstanceLoopCharacteristics is refused', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:callActivity id="CallSub" calledElement="sub-process">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false" />
    </bpmn:callActivity>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CallSub" />
    <bpmn:sequenceFlow id="F2" sourceRef="CallSub" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedLoopCharacteristicsError,
    );
  });

  // ── readDerivableName symmetry ────────────────────────────────────────────

  it('drops a call-activity name that exactly equals humanize(id)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:callActivity id="Fulfil_Order" name="Fulfil Order" calledElement="sub-process" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Fulfil_Order" />
    <bpmn:sequenceFlow id="F2" sourceRef="Fulfil_Order" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const call = ir.flowElements.find((fe) => fe.id === 'Fulfil_Order');
    expect(call && 'name' in call).toBe(false);
  });

  it('keeps a genuine call-activity label that differs from humanize(id)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:callActivity id="Fulfil_Order" name="Send the order to fulfilment" calledElement="sub-process" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Fulfil_Order" />
    <bpmn:sequenceFlow id="F2" sourceRef="Fulfil_Order" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const call = ir.flowElements.find((fe) => fe.id === 'Fulfil_Order');
    expect(call?.kind === 'callActivity' && call.name).toBe(
      'Send the order to fulfilment',
    );
  });
});

// ── 14. Event layer import: handlers, throws, emits, roots ──────────────────

describe('xmlToIr — event layer import', () => {
  // ── 14a. Full positive import (mirrors the ir-to-xml event-layer fixture) ─

  const fullEventXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_PF" name="PF" errorCode="PF" operaton:errorMessage="boom" />
  <bpmn:escalation id="Escalation_LS" name="LS" escalationCode="LS" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="ErrHandler" triggeredByEvent="true">
      <bpmn:startEvent id="ErrStart">
        <bpmn:errorEventDefinition id="ErrStartDef" errorRef="Error_PF"
          operaton:errorCodeVariable="c" operaton:errorMessageVariable="m" />
      </bpmn:startEvent>
      <bpmn:userTask id="Recover" />
      <bpmn:endEvent id="ErrEnd" />
      <bpmn:sequenceFlow id="SF_ErrStart_Recover" sourceRef="ErrStart" targetRef="Recover" />
      <bpmn:sequenceFlow id="SF_Recover_ErrEnd" sourceRef="Recover" targetRef="ErrEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="EscHandler" triggeredByEvent="true">
      <bpmn:startEvent id="EscStart" isInterrupting="false">
        <bpmn:escalationEventDefinition id="EscStartDef" escalationRef="Escalation_LS"
          camunda:escalationCodeVariable="v" />
      </bpmn:startEvent>
      <bpmn:userTask id="Notify" />
      <bpmn:endEvent id="EscEnd" />
      <bpmn:sequenceFlow id="SF_EscStart_Notify" sourceRef="EscStart" targetRef="Notify" />
      <bpmn:sequenceFlow id="SF_Notify_EscEnd" sourceRef="Notify" targetRef="EscEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Emit1">
      <bpmn:escalationEventDefinition id="Emit1Def" escalationRef="Escalation_LS" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowPF">
      <bpmn:errorEventDefinition id="ThrowPFDef" errorRef="Error_PF" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Emit1" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit1" targetRef="ThrowPF" />
  </bpmn:process>
</bpmn:definitions>`;

  const EXPECTED_EVENT_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    errorMessages: [{ code: 'PF', message: 'boom' }],
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
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
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'Emit1' },
      { id: 'F2', sourceRef: 'Emit1', targetRef: 'ThrowPF' },
    ],
  };

  it('imports an interrupting error handler, an alongside escalation handler (camunda: binding alias), a typed end, and an emit, sharing their roots, into the exact expected IR (deep equality)', async () => {
    const { ir, warnings } = await xmlToIr(fullEventXml);
    expect(ir).toEqual(EXPECTED_EVENT_IR);
    expect(warnings).toEqual([]);
  });

  // ── 14b. Catch-all ────────────────────────────────────────────────────────

  it('a handler definition without errorRef imports with the code absent (catch-all)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="AnyErr" triggeredByEvent="true">
      <bpmn:startEvent id="AnyStart">
        <bpmn:errorEventDefinition id="d" />
      </bpmn:startEvent>
      <bpmn:endEvent id="AnyEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="AnyStart" targetRef="AnyEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const handler = ir.flowElements.find((fe) => fe.id === 'AnyErr');
    expect(handler?.kind).toBe('subProcess');
    if (handler?.kind !== 'subProcess') return;
    const start = handler.flowElements.find((fe) => fe.id === 'AnyStart');
    expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
      kind: 'error',
    });
  });

  it('a ref to a code-less bpmn:Error root imports with the code absent', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_NoCode" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="AnyErr" triggeredByEvent="true">
      <bpmn:startEvent id="AnyStart">
        <bpmn:errorEventDefinition id="d" errorRef="Error_NoCode" />
      </bpmn:startEvent>
      <bpmn:endEvent id="AnyEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="AnyStart" targetRef="AnyEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir } = await xmlToIr(xml);
    const handler = ir.flowElements.find((fe) => fe.id === 'AnyErr');
    expect(handler?.kind).toBe('subProcess');
    if (handler?.kind !== 'subProcess') return;
    const start = handler.flowElements.find((fe) => fe.id === 'AnyStart');
    expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
      kind: 'error',
    });
  });

  it('a code-less bpmn:Error root warns about the missing code, not "never caught"', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_NoCode" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="AnyErr" triggeredByEvent="true">
      <bpmn:startEvent id="AnyStart">
        <bpmn:errorEventDefinition id="d" errorRef="Error_NoCode" />
      </bpmn:startEvent>
      <bpmn:endEvent id="AnyEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="AnyStart" targetRef="AnyEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    // The root is referenced (errorRef), so "never caught or thrown" would be
    // false; the message names the real reason — a code-less root cannot be
    // keyed or represented.
    const { warnings } = await xmlToIr(xml);
    const w = warnings.find(
      (w) =>
        w.category === 'unreferencedRoot' && w.elementId === 'Error_NoCode',
    );
    expect(w).toBeDefined();
    expect(w?.message).toContain('has no code');
    expect(w?.message).not.toContain('never caught');
  });

  // ── 14c. Refusals (one per shape) ─────────────────────────────────────────

  describe('refusals', () => {
    it('a terminate definition on a handler start still refuses with UnsupportedEventDefinitionError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:terminateEventDefinition id="td" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventDefinitionError);
        const e = err as UnsupportedEventDefinitionError;
        expect(e.eventKind).toBe('start');
        expect(e.definitionType).toBe('bpmn:TerminateEventDefinition');
      }
    });

    it('an event handler with zero start events refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:userTask id="T" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('an event handler with two start events refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="S1"><bpmn:errorEventDefinition /></bpmn:startEvent>
      <bpmn:startEvent id="S2"><bpmn:errorEventDefinition /></bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('a handler start with two event definitions refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
        <bpmn:escalationEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('an event handler with an incoming flow refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:incoming>F1</bpmn:incoming>
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Handler" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('isInterrupting="false" on an error handler refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart" isInterrupting="false">
        <bpmn:errorEventDefinition errorRef="Error_X" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('an error end event with no resolvable code refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="ThrowNoCode">
      <bpmn:errorEventDefinition />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowNoCode" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('an error definition on an intermediate throw refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="BadEmit">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="BadEmit" />
    <bpmn:sequenceFlow id="F2" sourceRef="BadEmit" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('a "none" intermediate throw (no event definition) refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="NoneEmit" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="NoneEmit" />
    <bpmn:sequenceFlow id="F2" sourceRef="NoneEmit" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('two bpmn:Error roots sharing a code but disagreeing on the message refuse with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_A" errorCode="DUP" operaton:errorMessage="first" />
  <bpmn:error id="Error_B" errorCode="DUP" operaton:errorMessage="second" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });

    it('a declared message on a code-less bpmn:Error root refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_NoCode" operaton:errorMessage="oops" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
        UnsupportedEventFeatureError,
      );
    });
  });

  // ── 14d. Warn-drops ───────────────────────────────────────────────────────

  describe('warn-drops', () => {
    it('a genuine label on a typed end event warns once, attributed to it', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="ThrowX" name="Custom Label">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowX" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      const end = ir.flowElements.find((fe) => fe.id === 'ThrowX');
      expect(end && 'name' in end).toBe(false);

      const labelWarnings = warnings.filter((w) => w.category === 'label');
      expect(labelWarnings).toHaveLength(1);
      expect(labelWarnings[0].elementId).toBe('ThrowX');
      expect(labelWarnings[0].message).toContain('Custom Label');
    });

    it('a genuine label on an event handler warns once, attributed to it', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true" name="Custom Handler Label">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      const handler = ir.flowElements.find((fe) => fe.id === 'Handler');
      expect(handler && 'name' in handler).toBe(false);

      const labelWarnings = warnings.filter((w) => w.category === 'label');
      expect(labelWarnings).toHaveLength(1);
      expect(labelWarnings[0].elementId).toBe('Handler');
      expect(labelWarnings[0].message).toContain('Custom Handler Label');
    });

    it('operaton:errorCodeVariable on an error end event (throw side) warns — it has no effect there', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="ThrowX">
      <bpmn:errorEventDefinition errorRef="Error_X" operaton:errorCodeVariable="c" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ThrowX" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      // The binding attribute has no effect on the throw side — the IR
      // carries only the code.
      const end = ir.flowElements.find((fe) => fe.id === 'ThrowX');
      expect(end?.kind === 'endEvent' && end.eventDefinition).toEqual({
        kind: 'error',
        errorCode: 'X',
      });

      const w = warnings.find((w) => w.message.includes('errorCodeVariable'));
      expect(w).toBeDefined();
      expect(w?.elementId).toBe('ThrowX');
    });

    it('an unrelated operaton: attribute on a mapped event definition warns', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition errorRef="Error_X" operaton:asyncBefore="true" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { warnings } = await xmlToIr(xml);
      const w = warnings.find((w) => w.message.includes('asyncBefore'));
      expect(w).toBeDefined();
      expect(w?.elementId).toBe('HStart');
    });

    it('an unreferenced message-less bpmn:Error root warns once', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_Unused" errorCode="UNUSED" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      expect(ir.errorMessages).toBeUndefined();
      const unreferenced = warnings.filter(
        (w) => w.category === 'unreferencedRoot',
      );
      expect(unreferenced).toHaveLength(1);
      expect(unreferenced[0].elementId).toBe('Error_Unused');
    });

    it('an unreferenced root WITH code+message imports into errorMessages with NO warning', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:error id="Error_Declared" errorCode="DECL" operaton:errorMessage="declared but unused" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      expect(ir.errorMessages).toEqual([
        { code: 'DECL', message: 'declared but unused' },
      ]);
      expect(warnings).toEqual([]);
    });
  });

  // ── 14e. Nesting and still-refused kinds ─────────────────────────────────

  it('an event handler nested inside a plain sub-process imports into the nested container', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Work" />
      <bpmn:endEvent id="OEnd" />
      <bpmn:subProcess id="InnerHandler" triggeredByEvent="true">
        <bpmn:startEvent id="IHStart">
          <bpmn:errorEventDefinition errorRef="Error_X" />
        </bpmn:startEvent>
        <bpmn:endEvent id="IHEnd" />
        <bpmn:sequenceFlow id="SF_IH" sourceRef="IHStart" targetRef="IHEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="SF_OStart_Work" sourceRef="OStart" targetRef="Work" />
      <bpmn:sequenceFlow id="SF_Work_OEnd" sourceRef="Work" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    const outer = ir.flowElements.find((fe) => fe.id === 'Outer');
    expect(outer?.kind).toBe('subProcess');
    if (outer?.kind !== 'subProcess') return;

    const inner = outer.flowElements.find((fe) => fe.id === 'InnerHandler');
    expect(inner?.kind).toBe('subProcess');
    if (inner?.kind !== 'subProcess') return;
    expect(inner.triggeredByEvent).toBe(true);
    const innerStart = inner.flowElements.find((fe) => fe.id === 'IHStart');
    expect(
      innerStart?.kind === 'startEvent' && innerStart.eventDefinition,
    ).toEqual({ kind: 'error', errorCode: 'X' });
  });

  it('bpmn:IntermediateCatchEvent is imported, not refused (see the "intermediate catch event import" suite below)', async () => {
    // The pinned wholesale refusal for `bpmn:IntermediateCatchEvent` is
    // superseded by a positive import contract — see "xmlToIr —
    // intermediate catch event import" below for full coverage. This
    // assertion documents the flip: a well-formed catch no longer raises
    // UnsupportedElementError. An empty timer still refuses, but now with
    // UnsupportedEventFeatureError (an unsupported shape, not an
    // unsupported kind).
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait">
      <bpmn:timerEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedEventFeatureError,
    );
    await expect(xmlToIr(xml)).rejects.not.toBeInstanceOf(
      UnsupportedElementError,
    );
  });

  it('a normal (non-handler) start event with an error definition still refuses', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_X" errorCode="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S">
      <bpmn:errorEventDefinition errorRef="Error_X" />
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedEventDefinitionError);
      const e = err as UnsupportedEventDefinitionError;
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:ErrorEventDefinition');
    }
  });
});

// ── 15. Message/signal/timer/conditional import ─────────────────────────────

describe('xmlToIr — message/signal/timer/conditional import', () => {
  // ── 15a. Full positive import ───────────────────────────────────────────

  const fullNewKindsXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="MsgHandler" triggeredByEvent="true">
      <bpmn:startEvent id="MsgStart">
        <bpmn:messageEventDefinition id="MsgDef" messageRef="Message_Pay" />
      </bpmn:startEvent>
      <bpmn:endEvent id="MsgEnd" />
      <bpmn:sequenceFlow id="SF_Msg" sourceRef="MsgStart" targetRef="MsgEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="SigHandler" triggeredByEvent="true">
      <bpmn:startEvent id="SigStart" isInterrupting="false">
        <bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Ping" />
      </bpmn:startEvent>
      <bpmn:endEvent id="SigEnd" />
      <bpmn:sequenceFlow id="SF_Sig" sourceRef="SigStart" targetRef="SigEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="DurationHandler" triggeredByEvent="true">
      <bpmn:startEvent id="DurStart">
        <bpmn:timerEventDefinition id="DurDef">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="DurEnd" />
      <bpmn:sequenceFlow id="SF_Dur" sourceRef="DurStart" targetRef="DurEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="DateHandler" triggeredByEvent="true">
      <bpmn:startEvent id="DateStart">
        <bpmn:timerEventDefinition id="DateDef">
          <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="DateEnd" />
      <bpmn:sequenceFlow id="SF_Date" sourceRef="DateStart" targetRef="DateEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="CondHandler" triggeredByEvent="true">
      <bpmn:startEvent id="CondStart">
        <bpmn:conditionalEventDefinition id="CondDef">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="CondEnd" />
      <bpmn:sequenceFlow id="SF_Cond" sourceRef="CondStart" targetRef="CondEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="EmitSig">
      <bpmn:signalEventDefinition id="EmitSigDef" signalRef="Signal_Ping" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowSig">
      <bpmn:signalEventDefinition id="ThrowSigDef" signalRef="Signal_Ping" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="EmitSig" />
    <bpmn:sequenceFlow id="F2" sourceRef="EmitSig" targetRef="ThrowSig" />
  </bpmn:process>
</bpmn:definitions>`;

  const EXPECTED_NEW_KINDS_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'MsgHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'MsgStart',
            eventDefinition: {
              kind: 'message',
              messageName: 'PaymentReceived',
            },
          },
          { kind: 'endEvent', id: 'MsgEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Msg', sourceRef: 'MsgStart', targetRef: 'MsgEnd' },
        ],
      },
      {
        kind: 'subProcess',
        id: 'SigHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'SigStart',
            isInterrupting: false,
            eventDefinition: { kind: 'signal', signalName: 'Ping' },
          },
          { kind: 'endEvent', id: 'SigEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Sig', sourceRef: 'SigStart', targetRef: 'SigEnd' },
        ],
      },
      {
        kind: 'subProcess',
        id: 'DurationHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'DurStart',
            eventDefinition: {
              kind: 'timer',
              timerKind: 'duration',
              expression: 'PT1H',
            },
          },
          { kind: 'endEvent', id: 'DurEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Dur', sourceRef: 'DurStart', targetRef: 'DurEnd' },
        ],
      },
      {
        kind: 'subProcess',
        id: 'DateHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'DateStart',
            eventDefinition: {
              kind: 'timer',
              timerKind: 'date',
              expression: '2026-08-01T09:00:00',
            },
          },
          { kind: 'endEvent', id: 'DateEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Date', sourceRef: 'DateStart', targetRef: 'DateEnd' },
        ],
      },
      {
        kind: 'subProcess',
        id: 'CondHandler',
        triggeredByEvent: true,
        flowElements: [
          {
            kind: 'startEvent',
            id: 'CondStart',
            eventDefinition: {
              kind: 'conditional',
              condition: '${amount > 100}',
            },
          },
          { kind: 'endEvent', id: 'CondEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Cond', sourceRef: 'CondStart', targetRef: 'CondEnd' },
        ],
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'EmitSig',
        eventDefinition: { kind: 'signal', signalName: 'Ping' },
      },
      {
        kind: 'endEvent',
        id: 'ThrowSig',
        eventDefinition: { kind: 'signal', signalName: 'Ping' },
      },
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'EmitSig' },
      { id: 'F2', sourceRef: 'EmitSig', targetRef: 'ThrowSig' },
    ],
  };

  it('imports a message handler, a non-interrupting signal handler, duration/date timer handlers, a conditional handler, and a signal end+emit sharing one root, into the exact expected IR (deep equality), warnings: []', async () => {
    const { ir, warnings } = await xmlToIr(fullNewKindsXml);
    expect(ir).toEqual(EXPECTED_NEW_KINDS_IR);
    expect(warnings).toEqual([]);
  });

  // ── 15b. Refusals (one per shape) ───────────────────────────────────────

  describe('refusals', () => {
    it('a ref-less message definition refuses with UnsupportedEventFeatureError naming "message"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:messageEventDefinition id="d" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'message',
        );
      }
    });

    it('a signal ref to a nameless root refuses with UnsupportedEventFeatureError naming "signal"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:signal id="Signal_NoName" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:signalEventDefinition id="d" signalRef="Signal_NoName" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'signal',
        );
      }
    });

    it('a timer definition with zero time children refuses with UnsupportedEventFeatureError naming "timer"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:timerEventDefinition id="d" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain('timer');
      }
    });

    it('a timer definition with two time children refuses with UnsupportedEventFeatureError naming "timer"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:timerEventDefinition id="d">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
          <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain('timer');
      }
    });

    it('a timer definition with an empty body refuses with UnsupportedEventFeatureError naming "timer"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:timerEventDefinition id="d">
          <bpmn:timeDuration></bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain('timer');
      }
    });

    it('a conditional definition without a condition child refuses with UnsupportedEventFeatureError naming "conditional"', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:conditionalEventDefinition id="d" />
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'conditional',
        );
      }
    });

    it('operaton:variableName on a conditional definition refuses with UnsupportedEventFeatureError naming the attribute', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:conditionalEventDefinition id="d" operaton:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'variableName',
        );
      }
    });

    it('camunda:variableEvents on a conditional definition refuses with UnsupportedEventFeatureError naming the attribute', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:conditionalEventDefinition id="d" camunda:variableEvents="update">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'variableEvents',
        );
      }
    });

    it('a message definition on an end event refuses with UnsupportedEventDefinitionError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:message id="Message_X" name="X" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E">
      <bpmn:messageEventDefinition messageRef="Message_X" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventDefinitionError);
        const e = err as UnsupportedEventDefinitionError;
        expect(e.eventKind).toBe('end');
        expect(e.definitionType).toBe('bpmn:MessageEventDefinition');
      }
    });

    it('a conditional definition on an intermediate throw refuses with UnsupportedEventDefinitionError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="Emit">
      <bpmn:conditionalEventDefinition>
        <bpmn:condition>\${x}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Emit" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventDefinitionError);
        const e = err as UnsupportedEventDefinitionError;
        expect(e.eventKind).toBe('intermediate throw');
        expect(e.definitionType).toBe('bpmn:ConditionalEventDefinition');
      }
    });
  });

  // ── 15c. Root honesty ────────────────────────────────────────────────────

  describe('root honesty', () => {
    it('two bpmn:Signal roots sharing one name, each referenced, collapse to one IR name with no warning', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:signal id="Signal_A" name="Ping" />
  <bpmn:signal id="Signal_B" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:signalEventDefinition id="d1" signalRef="Signal_A" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Emit">
      <bpmn:signalEventDefinition id="d2" signalRef="Signal_B" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Emit" />
    <bpmn:sequenceFlow id="F2" sourceRef="Emit" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      expect(warnings).toEqual([]);
      const handler = ir.flowElements.find((fe) => fe.id === 'Handler');
      expect(handler?.kind).toBe('subProcess');
      if (handler?.kind !== 'subProcess') return;
      const start = handler.flowElements.find((fe) => fe.id === 'HStart');
      expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
        kind: 'signal',
        signalName: 'Ping',
      });
      const emit = ir.flowElements.find((fe) => fe.id === 'Emit');
      expect(
        emit?.kind === 'intermediateThrowEvent' && emit.eventDefinition,
      ).toEqual({
        kind: 'signal',
        signalName: 'Ping',
      });
    });

    it('an unreferenced bpmn:Message root warns once', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:message id="Message_Unused" name="Unused" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { warnings } = await xmlToIr(xml);
      const unreferenced = warnings.filter(
        (w) => w.category === 'unreferencedRoot',
      );
      expect(unreferenced).toHaveLength(1);
      expect(unreferenced[0].elementId).toBe('Message_Unused');
    });

    it('itemRef on a referenced bpmn:Message root warns once and still imports', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:itemDefinition id="Item_1" />
  <bpmn:message id="Message_X" name="X" itemRef="Item_1" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:messageEventDefinition id="d" messageRef="Message_X" />
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      const { ir, warnings } = await xmlToIr(xml);
      const handler = ir.flowElements.find((fe) => fe.id === 'Handler');
      expect(handler?.kind).toBe('subProcess');
      if (handler?.kind !== 'subProcess') return;
      const start = handler.flowElements.find((fe) => fe.id === 'HStart');
      expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
        kind: 'message',
        messageName: 'X',
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].elementId).toBe('Message_X');
      expect(warnings[0].message).toContain('itemRef');
    });
  });

  // ── 15d. camunda: parity + nesting ───────────────────────────────────────

  it('camunda:variableName on a conditional definition refuses the same way as operaton:variableName', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:conditionalEventDefinition id="d" camunda:variableName="amount">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
      expect((err as UnsupportedEventFeatureError).detail).toContain(
        'variableName',
      );
    }
  });

  it('a clean camunda:-free conditional handler is not false-refused', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:conditionalEventDefinition id="d">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="HStart" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
    const handler = ir.flowElements.find((fe) => fe.id === 'Handler');
    expect(handler?.kind).toBe('subProcess');
    if (handler?.kind !== 'subProcess') return;
    const start = handler.flowElements.find((fe) => fe.id === 'HStart');
    expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
      kind: 'conditional',
      condition: '${amount > 100}',
    });
  });

  it('a timer handler nested inside a plain sub-process imports into the nested container', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Work" />
      <bpmn:endEvent id="OEnd" />
      <bpmn:subProcess id="InnerTimerHandler" triggeredByEvent="true">
        <bpmn:startEvent id="ITStart">
          <bpmn:timerEventDefinition id="itd">
            <bpmn:timeDuration>PT30M</bpmn:timeDuration>
          </bpmn:timerEventDefinition>
        </bpmn:startEvent>
        <bpmn:endEvent id="ITEnd" />
        <bpmn:sequenceFlow id="SF_IT" sourceRef="ITStart" targetRef="ITEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="SF_OStart_Work" sourceRef="OStart" targetRef="Work" />
      <bpmn:sequenceFlow id="SF_Work_OEnd" sourceRef="Work" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    const outer = ir.flowElements.find((fe) => fe.id === 'Outer');
    expect(outer?.kind).toBe('subProcess');
    if (outer?.kind !== 'subProcess') return;

    const inner = outer.flowElements.find(
      (fe) => fe.id === 'InnerTimerHandler',
    );
    expect(inner?.kind).toBe('subProcess');
    if (inner?.kind !== 'subProcess') return;
    expect(inner.triggeredByEvent).toBe(true);
    const innerStart = inner.flowElements.find((fe) => fe.id === 'ITStart');
    expect(
      innerStart?.kind === 'startEvent' && innerStart.eventDefinition,
    ).toEqual({
      kind: 'timer',
      timerKind: 'duration',
      expression: 'PT30M',
    });
  });
});

// ── 16. Compensation import ──────────────────────────────────────────────────

describe('xmlToIr — compensation import', () => {
  // ── 16a. Full positive import ────────────────────────────────────────────

  const compensationXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:userTask id="ReserveRoom" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart">
          <bpmn:compensateEventDefinition id="UndoStartDef" />
        </bpmn:startEvent>
        <bpmn:userTask id="CancelRoom" />
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_CancelRoom" sourceRef="UndoStart" targetRef="CancelRoom" />
        <bpmn:sequenceFlow id="Flow_CancelRoom_UndoEnd" sourceRef="CancelRoom" targetRef="UndoEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_BStart_ReserveRoom" sourceRef="BStart" targetRef="ReserveRoom" />
      <bpmn:sequenceFlow id="Flow_ReserveRoom_BEnd" sourceRef="ReserveRoom" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="EmitUndo">
      <bpmn:compensateEventDefinition id="EmitUndoDef" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="ThrowUndoDef" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_PStart_Booking" sourceRef="PStart" targetRef="Booking" />
    <bpmn:sequenceFlow id="Flow_Booking_EmitUndo" sourceRef="Booking" targetRef="EmitUndo" />
    <bpmn:sequenceFlow id="Flow_EmitUndo_ThrowUndo" sourceRef="EmitUndo" targetRef="ThrowUndo" />
  </bpmn:process>
</bpmn:definitions>`;

  const EXPECTED_COMPENSATION_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      {
        kind: 'subProcess',
        id: 'Booking',
        flowElements: [
          { kind: 'startEvent', id: 'BStart' },
          { kind: 'userTask', id: 'ReserveRoom' },
          { kind: 'endEvent', id: 'BEnd' },
          {
            kind: 'subProcess',
            id: 'UndoBooking',
            triggeredByEvent: true,
            flowElements: [
              {
                kind: 'startEvent',
                id: 'UndoStart',
                eventDefinition: { kind: 'compensation' },
              },
              { kind: 'userTask', id: 'CancelRoom' },
              { kind: 'endEvent', id: 'UndoEnd' },
            ],
            sequenceFlows: [
              {
                id: 'Flow_UndoStart_CancelRoom',
                sourceRef: 'UndoStart',
                targetRef: 'CancelRoom',
              },
              {
                id: 'Flow_CancelRoom_UndoEnd',
                sourceRef: 'CancelRoom',
                targetRef: 'UndoEnd',
              },
            ],
          },
        ],
        sequenceFlows: [
          {
            id: 'Flow_BStart_ReserveRoom',
            sourceRef: 'BStart',
            targetRef: 'ReserveRoom',
          },
          {
            id: 'Flow_ReserveRoom_BEnd',
            sourceRef: 'ReserveRoom',
            targetRef: 'BEnd',
          },
        ],
      },
      {
        kind: 'intermediateThrowEvent',
        id: 'EmitUndo',
        eventDefinition: { kind: 'compensation' },
      },
      {
        kind: 'endEvent',
        id: 'ThrowUndo',
        eventDefinition: { kind: 'compensation' },
      },
    ],
    sequenceFlows: [
      { id: 'Flow_PStart_Booking', sourceRef: 'PStart', targetRef: 'Booking' },
      {
        id: 'Flow_Booking_EmitUndo',
        sourceRef: 'Booking',
        targetRef: 'EmitUndo',
      },
      {
        id: 'Flow_EmitUndo_ThrowUndo',
        sourceRef: 'EmitUndo',
        targetRef: 'ThrowUndo',
      },
    ],
  };

  it('imports a compensation handler hosted by the plain sub-process it compensates, a compensation emit, and a compensation throw, into the exact expected IR (deep equality), warnings: []', async () => {
    const { ir, warnings } = await xmlToIr(compensationXml);
    expect(ir).toEqual(EXPECTED_COMPENSATION_IR);
    expect(warnings).toEqual([]);
  });

  it('an explicit waitForCompletion="true" on both throw positions imports identically to the default (absent) form', async () => {
    const xml = compensationXml
      .replace(
        '<bpmn:compensateEventDefinition id="EmitUndoDef" />',
        '<bpmn:compensateEventDefinition id="EmitUndoDef" waitForCompletion="true" />',
      )
      .replace(
        '<bpmn:compensateEventDefinition id="ThrowUndoDef" />',
        '<bpmn:compensateEventDefinition id="ThrowUndoDef" waitForCompletion="true" />',
      );

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir).toEqual(EXPECTED_COMPENSATION_IR);
    expect(warnings).toEqual([]);
  });

  // ── 16b. Refusals (one per shape) ─────────────────────────────────────────

  describe('refusals', () => {
    it('an activityRef on a compensation handler-start definition refuses with UnsupportedEventFeatureError naming activityRef', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:userTask id="ReserveRoom" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart">
          <bpmn:compensateEventDefinition id="UndoStartDef" activityRef="ReserveRoom" />
        </bpmn:startEvent>
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_BStart_ReserveRoom" sourceRef="BStart" targetRef="ReserveRoom" />
      <bpmn:sequenceFlow id="Flow_ReserveRoom_BEnd" sourceRef="ReserveRoom" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="Flow_PStart_Booking" sourceRef="PStart" targetRef="Booking" />
    <bpmn:sequenceFlow id="Flow_Booking_PEnd" sourceRef="Booking" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'activityRef',
        );
      }
    });

    it('an activityRef on a compensation end-event definition refuses with UnsupportedEventFeatureError naming activityRef', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="T" />
    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="d" activityRef="T" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />
    <bpmn:sequenceFlow id="Flow_T_ThrowUndo" sourceRef="T" targetRef="ThrowUndo" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'activityRef',
        );
      }
    });

    it('waitForCompletion="false" on an intermediate throw refuses with UnsupportedEventFeatureError naming waitForCompletion', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateThrowEvent id="EmitUndo">
      <bpmn:compensateEventDefinition id="d" waitForCompletion="false" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="Flow_S_EmitUndo" sourceRef="S" targetRef="EmitUndo" />
    <bpmn:sequenceFlow id="Flow_EmitUndo_E" sourceRef="EmitUndo" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'waitForCompletion',
        );
      }
    });

    it('waitForCompletion="false" on an end event refuses with UnsupportedEventFeatureError naming waitForCompletion', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="ThrowUndo">
      <bpmn:compensateEventDefinition id="d" waitForCompletion="false" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_S_ThrowUndo" sourceRef="S" targetRef="ThrowUndo" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'waitForCompletion',
        );
      }
    });

    it('isInterrupting="false" on a compensation handler start refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart" isInterrupting="false">
          <bpmn:compensateEventDefinition id="d" />
        </bpmn:startEvent>
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_BStart_BEnd" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="Flow_PStart_Booking" sourceRef="PStart" targetRef="Booking" />
    <bpmn:sequenceFlow id="Flow_Booking_PEnd" sourceRef="Booking" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'non-interrupting',
        );
      }
    });

    it('a compensation event sub-process hosted directly by the process refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
      <bpmn:startEvent id="UndoStart">
        <bpmn:compensateEventDefinition id="d" />
      </bpmn:startEvent>
      <bpmn:endEvent id="UndoEnd" />
      <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const detail = (err as UnsupportedEventFeatureError).detail;
        expect(detail).toContain('the process');
        expect(detail).toContain('compensat');
      }
    });

    it('a compensation event sub-process hosted by another event sub-process refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="OuterHandler" triggeredByEvent="true">
      <bpmn:startEvent id="OuterStart">
        <bpmn:errorEventDefinition id="od" />
      </bpmn:startEvent>
      <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
        <bpmn:startEvent id="UndoStart">
          <bpmn:compensateEventDefinition id="d" />
        </bpmn:startEvent>
        <bpmn:endEvent id="UndoEnd" />
        <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
      </bpmn:subProcess>
      <bpmn:endEvent id="OuterEnd" />
      <bpmn:sequenceFlow id="Flow_OuterStart_OuterEnd" sourceRef="OuterStart" targetRef="OuterEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const detail = (err as UnsupportedEventFeatureError).detail;
        expect(detail).toContain('another event sub-process');
        expect(detail).toContain('compensat');
      }
    });

    it('isForCompensation="true" on a service task refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="CancelReservation" operaton:class="com.example.Cancel" isForCompensation="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="CancelReservation" />
    <bpmn:sequenceFlow id="F2" sourceRef="CancelReservation" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('CancelReservation');
        expect(e.detail).toContain('isForCompensation');
      }
    });

    it('isForCompensation="true" on a sub-process refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:subProcess id="UndoBlock" isForCompensation="true">
      <bpmn:startEvent id="US" />
      <bpmn:endEvent id="UE" />
      <bpmn:sequenceFlow id="Flow_US_UE" sourceRef="US" targetRef="UE" />
    </bpmn:subProcess>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="UndoBlock" />
    <bpmn:sequenceFlow id="F2" sourceRef="UndoBlock" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('UndoBlock');
        expect(e.detail).toContain('isForCompensation');
      }
    });

    it('a compensation boundary event refuses with UnsupportedEventFeatureError naming the subprocess undo block', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:serviceTask id="ReserveRoom" operaton:class="com.example.Reserve" />
    <bpmn:boundaryEvent id="CompensationBoundary" attachedToRef="ReserveRoom">
      <bpmn:compensateEventDefinition id="d" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="ReserveRoom" />
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveRoom" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('CompensationBoundary');
        expect(e.detail).toContain('compensation');
        expect(e.detail).toContain('on compensation');
      }
    });
  });

  // ── 16c. Six prior kinds untouched + deeper nesting ──────────────────────

  it('the six prior definition kinds (error, escalation, message, signal, timer, conditional) still import through their untouched arms', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_PF" name="PF" errorCode="PF" />
  <bpmn:escalation id="Escalation_LS" name="LS" escalationCode="LS" />
  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="ErrHandler" triggeredByEvent="true">
      <bpmn:startEvent id="ErrStart">
        <bpmn:errorEventDefinition id="ErrStartDef" errorRef="Error_PF" />
      </bpmn:startEvent>
      <bpmn:endEvent id="ErrEnd" />
      <bpmn:sequenceFlow id="Flow_ErrStart_ErrEnd" sourceRef="ErrStart" targetRef="ErrEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="EscHandler" triggeredByEvent="true">
      <bpmn:startEvent id="EscStart">
        <bpmn:escalationEventDefinition id="EscStartDef" escalationRef="Escalation_LS" />
      </bpmn:startEvent>
      <bpmn:endEvent id="EscEnd" />
      <bpmn:sequenceFlow id="Flow_EscStart_EscEnd" sourceRef="EscStart" targetRef="EscEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="MsgHandler" triggeredByEvent="true">
      <bpmn:startEvent id="MsgStart">
        <bpmn:messageEventDefinition id="MsgDef" messageRef="Message_Pay" />
      </bpmn:startEvent>
      <bpmn:endEvent id="MsgEnd" />
      <bpmn:sequenceFlow id="Flow_MsgStart_MsgEnd" sourceRef="MsgStart" targetRef="MsgEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="SigHandler" triggeredByEvent="true">
      <bpmn:startEvent id="SigStart">
        <bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Ping" />
      </bpmn:startEvent>
      <bpmn:endEvent id="SigEnd" />
      <bpmn:sequenceFlow id="Flow_SigStart_SigEnd" sourceRef="SigStart" targetRef="SigEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="TimerHandler" triggeredByEvent="true">
      <bpmn:startEvent id="TimerStart">
        <bpmn:timerEventDefinition id="TimerDef">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="TimerEnd" />
      <bpmn:sequenceFlow id="Flow_TimerStart_TimerEnd" sourceRef="TimerStart" targetRef="TimerEnd" />
    </bpmn:subProcess>
    <bpmn:subProcess id="CondHandler" triggeredByEvent="true">
      <bpmn:startEvent id="CondStart">
        <bpmn:conditionalEventDefinition id="CondDef">
          <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:endEvent id="CondEnd" />
      <bpmn:sequenceFlow id="Flow_CondStart_CondEnd" sourceRef="CondStart" targetRef="CondEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="Flow_PStart_PEnd" sourceRef="PStart" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const EXPECTED_SMOKE_IR: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'PStart' },
        {
          kind: 'subProcess',
          id: 'ErrHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'ErrStart',
              eventDefinition: { kind: 'error', errorCode: 'PF' },
            },
            { kind: 'endEvent', id: 'ErrEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_ErrStart_ErrEnd',
              sourceRef: 'ErrStart',
              targetRef: 'ErrEnd',
            },
          ],
        },
        {
          kind: 'subProcess',
          id: 'EscHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'EscStart',
              eventDefinition: { kind: 'escalation', escalationCode: 'LS' },
            },
            { kind: 'endEvent', id: 'EscEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_EscStart_EscEnd',
              sourceRef: 'EscStart',
              targetRef: 'EscEnd',
            },
          ],
        },
        {
          kind: 'subProcess',
          id: 'MsgHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'MsgStart',
              eventDefinition: {
                kind: 'message',
                messageName: 'PaymentReceived',
              },
            },
            { kind: 'endEvent', id: 'MsgEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_MsgStart_MsgEnd',
              sourceRef: 'MsgStart',
              targetRef: 'MsgEnd',
            },
          ],
        },
        {
          kind: 'subProcess',
          id: 'SigHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'SigStart',
              eventDefinition: { kind: 'signal', signalName: 'Ping' },
            },
            { kind: 'endEvent', id: 'SigEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_SigStart_SigEnd',
              sourceRef: 'SigStart',
              targetRef: 'SigEnd',
            },
          ],
        },
        {
          kind: 'subProcess',
          id: 'TimerHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'TimerStart',
              eventDefinition: {
                kind: 'timer',
                timerKind: 'duration',
                expression: 'PT1H',
              },
            },
            { kind: 'endEvent', id: 'TimerEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_TimerStart_TimerEnd',
              sourceRef: 'TimerStart',
              targetRef: 'TimerEnd',
            },
          ],
        },
        {
          kind: 'subProcess',
          id: 'CondHandler',
          triggeredByEvent: true,
          flowElements: [
            {
              kind: 'startEvent',
              id: 'CondStart',
              eventDefinition: {
                kind: 'conditional',
                condition: '${amount > 100}',
              },
            },
            { kind: 'endEvent', id: 'CondEnd' },
          ],
          sequenceFlows: [
            {
              id: 'Flow_CondStart_CondEnd',
              sourceRef: 'CondStart',
              targetRef: 'CondEnd',
            },
          ],
        },
        { kind: 'endEvent', id: 'PEnd' },
      ],
      sequenceFlows: [
        { id: 'Flow_PStart_PEnd', sourceRef: 'PStart', targetRef: 'PEnd' },
      ],
    };

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir).toEqual(EXPECTED_SMOKE_IR);
    expect(warnings).toEqual([]);
  });

  it('a compensation handler nested inside a plain sub-process nested inside another plain sub-process imports into the deepest container', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:subProcess id="Inner">
        <bpmn:startEvent id="IStart" />
        <bpmn:userTask id="ReserveRoom" />
        <bpmn:endEvent id="IEnd" />
        <bpmn:subProcess id="UndoBooking" triggeredByEvent="true">
          <bpmn:startEvent id="UndoStart">
            <bpmn:compensateEventDefinition id="UndoStartDef" />
          </bpmn:startEvent>
          <bpmn:endEvent id="UndoEnd" />
          <bpmn:sequenceFlow id="Flow_UndoStart_UndoEnd" sourceRef="UndoStart" targetRef="UndoEnd" />
        </bpmn:subProcess>
        <bpmn:sequenceFlow id="Flow_IStart_ReserveRoom" sourceRef="IStart" targetRef="ReserveRoom" />
        <bpmn:sequenceFlow id="Flow_ReserveRoom_IEnd" sourceRef="ReserveRoom" targetRef="IEnd" />
      </bpmn:subProcess>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="Flow_OStart_Inner" sourceRef="OStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="Flow_Inner_OEnd" sourceRef="Inner" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="Flow_PStart_Outer" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="Flow_Outer_PEnd" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    const outer = ir.flowElements.find((fe) => fe.id === 'Outer');
    expect(outer?.kind).toBe('subProcess');
    if (outer?.kind !== 'subProcess') return;

    const inner = outer.flowElements.find((fe) => fe.id === 'Inner');
    expect(inner?.kind).toBe('subProcess');
    if (inner?.kind !== 'subProcess') return;

    const handler = inner.flowElements.find((fe) => fe.id === 'UndoBooking');
    expect(handler?.kind).toBe('subProcess');
    if (handler?.kind !== 'subProcess') return;
    expect(handler.triggeredByEvent).toBe(true);

    const start = handler.flowElements.find((fe) => fe.id === 'UndoStart');
    expect(start?.kind === 'startEvent' && start.eventDefinition).toEqual({
      kind: 'compensation',
    });
    expect(
      start?.kind === 'startEvent' && start.isInterrupting,
    ).toBeUndefined();
  });
});

// ── 17. Boundary event import ────────────────────────────────────────────────

describe('xmlToIr — boundary event import', () => {
  // ── 17a. Full positive import: six triggers, cancelActivity, escalation host ─

  const boundaryXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:error id="Error_Oops" errorCode="OOPS" />
  <bpmn:message id="Message_Ping" name="Ping" />
  <bpmn:signal id="Signal_Go" name="Go" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:subProcess id="Booking">
      <bpmn:startEvent id="BStart" />
      <bpmn:endEvent id="BEnd" />
      <bpmn:sequenceFlow id="SF_Booking" sourceRef="BStart" targetRef="BEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:boundaryEvent id="Boundary_Review_error" attachedToRef="Review">
      <bpmn:errorEventDefinition id="ErrDef" errorRef="Error_Oops" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_message" attachedToRef="Review" cancelActivity="false">
      <bpmn:messageEventDefinition id="MsgDef" messageRef="Message_Ping" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_signal" attachedToRef="Review">
      <bpmn:signalEventDefinition id="SigDef" signalRef="Signal_Go" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Review_condition" attachedToRef="Review">
      <bpmn:conditionalEventDefinition id="CondDef">
        <bpmn:condition>\${flag}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Booking_escalation" attachedToRef="Booking">
      <bpmn:escalationEventDefinition id="EscDef" />
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="Booking" />
    <bpmn:sequenceFlow id="F3" sourceRef="Booking" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

  const EXPECTED_BOUNDARY_IR: BpmnProcess = {
    id: 'p',
    isExecutable: true,
    flowElements: [
      { kind: 'startEvent', id: 'PStart' },
      { kind: 'userTask', id: 'Review' },
      {
        kind: 'subProcess',
        id: 'Booking',
        flowElements: [
          { kind: 'startEvent', id: 'BStart' },
          { kind: 'endEvent', id: 'BEnd' },
        ],
        sequenceFlows: [
          { id: 'SF_Booking', sourceRef: 'BStart', targetRef: 'BEnd' },
        ],
      },
      { kind: 'endEvent', id: 'PEnd' },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Review_error',
        attachedToRef: 'Review',
        eventDefinition: { kind: 'error', errorCode: 'OOPS' },
      },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Review_message',
        attachedToRef: 'Review',
        eventDefinition: { kind: 'message', messageName: 'Ping' },
        cancelActivity: false,
      },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Review_signal',
        attachedToRef: 'Review',
        eventDefinition: { kind: 'signal', signalName: 'Go' },
      },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Review_timer',
        attachedToRef: 'Review',
        eventDefinition: {
          kind: 'timer',
          timerKind: 'duration',
          expression: 'PT2H',
        },
      },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Review_condition',
        attachedToRef: 'Review',
        eventDefinition: { kind: 'conditional', condition: '${flag}' },
      },
      {
        kind: 'boundaryEvent',
        id: 'Boundary_Booking_escalation',
        attachedToRef: 'Booking',
        eventDefinition: { kind: 'escalation' },
      },
    ],
    sequenceFlows: [
      { id: 'F1', sourceRef: 'PStart', targetRef: 'Review' },
      { id: 'F2', sourceRef: 'Review', targetRef: 'Booking' },
      { id: 'F3', sourceRef: 'Booking', targetRef: 'PEnd' },
    ],
  };

  it('imports all six boundary triggers with the right attachedToRef, cancelActivity, and an escalation boundary on a sub-process host, with zero warnings', async () => {
    const { ir, warnings } = await xmlToIr(boundaryXml);
    expect(ir).toEqual(EXPECTED_BOUNDARY_IR);
    expect(warnings).toEqual([]);
  });

  it('a boundary event on a host nested inside a sub-process imports at that depth', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Outer">
      <bpmn:startEvent id="OStart" />
      <bpmn:userTask id="Pack" />
      <bpmn:boundaryEvent id="Boundary_Pack_timer" attachedToRef="Pack">
        <bpmn:timerEventDefinition id="TimerDef">
          <bpmn:timeDuration>PT30M</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:boundaryEvent>
      <bpmn:endEvent id="OEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="OStart" targetRef="Pack" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Pack" targetRef="OEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);

    const outer = ir.flowElements.find((fe) => fe.id === 'Outer');
    expect(outer?.kind).toBe('subProcess');
    if (outer?.kind !== 'subProcess') return;

    const boundary = outer.flowElements.find(
      (fe) => fe.id === 'Boundary_Pack_timer',
    );
    expect(boundary).toEqual({
      kind: 'boundaryEvent',
      id: 'Boundary_Pack_timer',
      attachedToRef: 'Pack',
      eventDefinition: {
        kind: 'timer',
        timerKind: 'duration',
        expression: 'PT30M',
      },
    });
  });

  // ── 17b. Refusals (one per shape) ───────────────────────────────────────

  describe('refusals', () => {
    it('a missing attachedToRef refuses with UnsupportedEventFeatureError naming attachedToRef', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Orphan">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Orphan');
        expect(e.detail).toContain('attachedToRef');
      }
    });

    it('an incoming sequence flow refuses with UnsupportedEventFeatureError naming incoming', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:incoming>F0</bpmn:incoming>
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F0" sourceRef="PStart" targetRef="Boundary_Review_timer" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Review_timer');
        expect(e.detail).toContain('incoming');
      }
    });

    it('an operaton:inputOutput mapping refuses with UnsupportedEventFeatureError naming inputOutput', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:extensionElements>
        <operaton:inputOutput>
          <operaton:inputParameter name="foo">bar</operaton:inputParameter>
        </operaton:inputOutput>
      </bpmn:extensionElements>
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Review_timer');
        expect(e.detail).toContain('inputOutput');
      }
    });

    it('a trigger definition kind outside the six supported refuses with UnsupportedEventDefinitionError naming the boundary position', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_cancel" attachedToRef="Review">
      <bpmn:cancelEventDefinition id="CancelDef" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventDefinitionError);
        const e = err as UnsupportedEventDefinitionError;
        expect(e.eventKind).toBe('boundary');
        expect(e.definitionType).toBe('bpmn:CancelEventDefinition');
      }
    });

    it('cancelActivity="false" on an error boundary refuses with UnsupportedEventFeatureError naming cancelActivity', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_error" attachedToRef="Review" cancelActivity="false">
      <bpmn:errorEventDefinition id="ErrDef" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Review_error');
        expect(e.detail).toContain('cancelActivity');
      }
    });

    it('an escalation boundary on a service task refuses with UnsupportedEventFeatureError naming the legal host kinds', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:serviceTask id="Ship" operaton:class="com.example.Ship" />
    <bpmn:boundaryEvent id="Boundary_Ship_escalation" attachedToRef="Ship">
      <bpmn:escalationEventDefinition id="EscDef" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Ship" />
    <bpmn:sequenceFlow id="F2" sourceRef="Ship" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Ship_escalation');
        expect(e.detail).toContain('sub-process');
        expect(e.detail).toContain('call activity');
        expect(e.detail).toContain('user task');
      }
    });

    it('an attachedToRef naming an activity in a different container refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:subProcess id="Elsewhere">
      <bpmn:startEvent id="EStart" />
      <bpmn:userTask id="Other" />
      <bpmn:endEvent id="EEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="EStart" targetRef="Other" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Other" targetRef="EEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="Boundary_Other_timer" attachedToRef="Other">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Elsewhere" />
    <bpmn:sequenceFlow id="F2" sourceRef="Elsewhere" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Other_timer');
        expect(e.detail).toContain('attachedToRef');
      }
    });

    it('a boundary event inside a sub-process attached to an id in the outer process refuses', async () => {
      // The mirror of the case above: nesting runs its own host check over its
      // own container, so an id that exists one level out is not in scope.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Outer" />
    <bpmn:subProcess id="Wrap">
      <bpmn:startEvent id="WStart" />
      <bpmn:userTask id="Inner" />
      <bpmn:boundaryEvent id="Boundary_Outer_timer" attachedToRef="Outer">
        <bpmn:timerEventDefinition id="TimerDef">
          <bpmn:timeDuration>PT1H</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
      </bpmn:boundaryEvent>
      <bpmn:endEvent id="WEnd" />
      <bpmn:sequenceFlow id="SF1" sourceRef="WStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="SF2" sourceRef="Inner" targetRef="WEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Outer" />
    <bpmn:sequenceFlow id="F2" sourceRef="Outer" targetRef="Wrap" />
    <bpmn:sequenceFlow id="F3" sourceRef="Wrap" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Outer_timer');
        expect(e.detail).toContain('attachedToRef');
      }
    });

    it('an attachedToRef naming a gateway in the same container refuses', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:exclusiveGateway id="Choose" />
    <bpmn:boundaryEvent id="Boundary_Choose_timer" attachedToRef="Choose">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Choose" />
    <bpmn:sequenceFlow id="F2" sourceRef="Choose" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Choose_timer');
        expect(e.detail).toContain('attachedToRef');
      }
    });

    it('an attachedToRef naming an event sub-process refuses', async () => {
      // An event sub-process is authored as a bare `on <trigger> { … }` and
      // carries no id or name of its own, so nothing could name it as a host.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:subProcess id="Handler" triggeredByEvent="true">
      <bpmn:startEvent id="HStart">
        <bpmn:errorEventDefinition id="HErrDef" />
      </bpmn:startEvent>
      <bpmn:userTask id="Recover" />
      <bpmn:endEvent id="HEnd" />
      <bpmn:sequenceFlow id="HF1" sourceRef="HStart" targetRef="Recover" />
      <bpmn:sequenceFlow id="HF2" sourceRef="Recover" targetRef="HEnd" />
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="Boundary_Handler_timer" attachedToRef="Handler">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Handler_timer');
        expect(e.detail).toContain('attachedToRef');
      }
    });

    it('a sequence flow targeting a boundary event refuses even with no bpmn:incoming child', async () => {
      // `<bpmn:incoming>` is optional in BPMN and moddle fills `incoming` from
      // those children alone, so the flow's own targetRef is what has to be
      // checked; Operaton reads it either way.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F0" sourceRef="PStart" targetRef="Boundary_Review_timer" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        const e = err as UnsupportedEventFeatureError;
        expect(e.elementId).toBe('Boundary_Review_timer');
        expect(e.detail).toContain('incoming');
      }
    });
  });

  // ── 17c. Host resolution independent of document order, and the label drop ──

  it('a boundary event written before its host imports cleanly', async () => {
    // The whole reason host checking is a post-loop pass: moddle presents
    // children in document order, and BPMN does not require the host first.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" attachedToRef="Review">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:userTask id="Review" />
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { ir, warnings } = await xmlToIr(xml);
    expect(warnings).toEqual([]);
    expect(
      ir.flowElements.find((fe) => fe.id === 'Boundary_Review_timer'),
    ).toEqual({
      kind: 'boundaryEvent',
      id: 'Boundary_Review_timer',
      attachedToRef: 'Review',
      eventDefinition: {
        kind: 'timer',
        timerKind: 'duration',
        expression: 'PT1H',
      },
    });
  });

  it('a name on a boundary event is dropped with exactly one label warning', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="PStart" />
    <bpmn:userTask id="Review" />
    <bpmn:boundaryEvent id="Boundary_Review_timer" name="Timed out" attachedToRef="Review">
      <bpmn:timerEventDefinition id="TimerDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="PEnd" />
    <bpmn:sequenceFlow id="F1" sourceRef="PStart" targetRef="Review" />
    <bpmn:sequenceFlow id="F2" sourceRef="Review" targetRef="PEnd" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    const labelWarnings = warnings.filter((w) => w.category === 'label');
    expect(labelWarnings).toHaveLength(1);
    expect(labelWarnings[0]!.elementId).toBe('Boundary_Review_timer');
    expect(labelWarnings[0]!.message).toContain('Timed out');
    expect(labelWarnings[0]!.message).toContain('a boundary event');
  });
});

// ── 18. Intermediate catch event import ──────────────────────────────────────

describe('xmlToIr — intermediate catch event import', () => {
  // ── 18a. Map: the four supported triggers, on the main flow ────────────────

  it('imports message, timer (duration/date/cycle), signal, and conditional catches into the exact expected IR, incoming/outgoing preserved, warnings: []', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="WaitMsg">
      <bpmn:messageEventDefinition id="WaitMsgDef" messageRef="Message_Pay" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitDur">
      <bpmn:timerEventDefinition id="WaitDurDef">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitDate">
      <bpmn:timerEventDefinition id="WaitDateDef">
        <bpmn:timeDate>2026-08-01T09:00:00</bpmn:timeDate>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitCycle">
      <bpmn:timerEventDefinition id="WaitCycleDef">
        <bpmn:timeCycle>R3/PT10M</bpmn:timeCycle>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitSig">
      <bpmn:signalEventDefinition id="WaitSigDef" signalRef="Signal_Ping" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="WaitCond">
      <bpmn:conditionalEventDefinition id="WaitCondDef">
        <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="WaitMsg" />
    <bpmn:sequenceFlow id="F2" sourceRef="WaitMsg" targetRef="WaitDur" />
    <bpmn:sequenceFlow id="F3" sourceRef="WaitDur" targetRef="WaitDate" />
    <bpmn:sequenceFlow id="F4" sourceRef="WaitDate" targetRef="WaitCycle" />
    <bpmn:sequenceFlow id="F5" sourceRef="WaitCycle" targetRef="WaitSig" />
    <bpmn:sequenceFlow id="F6" sourceRef="WaitSig" targetRef="WaitCond" />
    <bpmn:sequenceFlow id="F7" sourceRef="WaitCond" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

    const expectedIr: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'Start' },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitMsg',
          eventDefinition: { kind: 'message', messageName: 'PaymentReceived' },
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitDur',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'duration',
            expression: 'PT1H',
          },
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitDate',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'date',
            expression: '2026-08-01T09:00:00',
          },
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitCycle',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'cycle',
            expression: 'R3/PT10M',
          },
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitSig',
          eventDefinition: { kind: 'signal', signalName: 'Ping' },
        },
        {
          kind: 'intermediateCatchEvent',
          id: 'WaitCond',
          eventDefinition: {
            kind: 'conditional',
            condition: '${amount > 100}',
          },
        },
        { kind: 'endEvent', id: 'End' },
      ],
      sequenceFlows: [
        { id: 'F1', sourceRef: 'Start', targetRef: 'WaitMsg' },
        { id: 'F2', sourceRef: 'WaitMsg', targetRef: 'WaitDur' },
        { id: 'F3', sourceRef: 'WaitDur', targetRef: 'WaitDate' },
        { id: 'F4', sourceRef: 'WaitDate', targetRef: 'WaitCycle' },
        { id: 'F5', sourceRef: 'WaitCycle', targetRef: 'WaitSig' },
        { id: 'F6', sourceRef: 'WaitSig', targetRef: 'WaitCond' },
        { id: 'F7', sourceRef: 'WaitCond', targetRef: 'End' },
      ],
    };

    const { ir, warnings } = await xmlToIr(xml);
    expect(ir).toEqual(expectedIr);
    expect(warnings).toEqual([]);

    // Every catch sits on the main flow: exactly one incoming and one
    // outgoing sequence flow apiece.
    for (const catchId of [
      'WaitMsg',
      'WaitDur',
      'WaitDate',
      'WaitCycle',
      'WaitSig',
      'WaitCond',
    ]) {
      expect(
        ir.sequenceFlows.filter((f) => f.targetRef === catchId),
      ).toHaveLength(1);
      expect(
        ir.sequenceFlows.filter((f) => f.sourceRef === catchId),
      ).toHaveLength(1);
    }
  });

  it('a genuine label on an intermediate catch is dropped with exactly one label warning', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:message id="Message_Pay" name="PaymentReceived" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait" name="Awaiting payment">
      <bpmn:messageEventDefinition id="d" messageRef="Message_Pay" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    const { warnings } = await xmlToIr(xml);
    const labelWarnings = warnings.filter((w) => w.category === 'label');
    expect(labelWarnings).toHaveLength(1);
    expect(labelWarnings[0]!.elementId).toBe('Wait');
    expect(labelWarnings[0]!.message).toContain('Awaiting payment');
    expect(labelWarnings[0]!.message).toContain('an await');
  });

  // ── 18b. Refuse trigger: link, error, escalation, compensation, cancel ─────

  describe('refuses an unsupported trigger', () => {
    const unsupportedTriggerXml = (
      definitionXml: string,
    ) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait">
      ${definitionXml}
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    it.each([
      [
        'link',
        '<bpmn:linkEventDefinition id="d" name="X" />',
        'LinkEventDefinition',
      ],
      ['error', '<bpmn:errorEventDefinition id="d" />', 'ErrorEventDefinition'],
      [
        'escalation',
        '<bpmn:escalationEventDefinition id="d" />',
        'EscalationEventDefinition',
      ],
      [
        'compensation',
        '<bpmn:compensateEventDefinition id="d" />',
        'CompensateEventDefinition',
      ],
      [
        'cancel',
        '<bpmn:cancelEventDefinition id="d" />',
        'CancelEventDefinition',
      ],
    ] as const)(
      'a %s trigger refuses with UnsupportedEventFeatureError naming the form',
      async (_label, definitionXml, expectedTypeName) => {
        try {
          await xmlToIr(unsupportedTriggerXml(definitionXml));
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
          expect((err as UnsupportedEventFeatureError).elementId).toBe('Wait');
          expect((err as UnsupportedEventFeatureError).detail).toContain(
            expectedTypeName,
          );
        }
      },
    );
  });

  // ── 18c. Refuse multiple: >1 event definition, or parallelMultiple ─────────

  describe('refuses multiple triggers', () => {
    it('two event definitions on one catch refuse with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait">
      <bpmn:timerEventDefinition id="d1">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
      <bpmn:signalEventDefinition id="d2" signalRef="Signal_Ping" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          '2 event definitions',
        );
      }
    });

    it('parallelMultiple="true" refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:signal id="Signal_Ping" name="Ping" />
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait" parallelMultiple="true">
      <bpmn:signalEventDefinition id="d" signalRef="Signal_Ping" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain(
          'parallelMultiple',
        );
      }
    });

    it('a "none" catch with zero event definitions refuses with UnsupportedEventFeatureError', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

      try {
        await xmlToIr(xml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
        expect((err as UnsupportedEventFeatureError).detail).toContain('none');
      }
    });
  });

  // ── 18d. Refuse narrowing: inherited from readCatchEventDefinition ─────────

  it('operaton:variableName on a conditional catch refuses with UnsupportedEventFeatureError naming the attribute (ADR-0017, inherited from readCatchEventDefinition)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:intermediateCatchEvent id="Wait">
      <bpmn:conditionalEventDefinition id="d" operaton:variableName="amount">
        <bpmn:condition>\${amount &gt; 100}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="Wait" />
    <bpmn:sequenceFlow id="F2" sourceRef="Wait" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
      expect((err as UnsupportedEventFeatureError).detail).toContain(
        'variableName',
      );
    }
  });
});
