/**
 * End-to-end round-trip for the event layer (error and escalation) over the
 * unmocked transform chain: real Langium parse and validation, real
 * `bpmn-moddle` via `irToXml`/`xmlToIr`, and real `bpmn-auto-layout` inside
 * `irToXml`. No Docker and no engine.
 *
 * One order-processing narrative exercises an `error ... message` declaration, a
 * payment `subprocess` that throws inside an `if`, escalates mid-chain, and owns
 * an interrupting `on error` handler with both catch bindings, a process-level
 * non-interrupting `on escalation` handler, a catch-all `on error` handler, a
 * terminal `throw escalation`, explicit ids on a throw and an emit with a `goto`
 * targeting the named emit, and a process variable named `message` used in a
 * condition, pinning that the contextual event words coexist with same-named
 * variables.
 *
 * The frozen `.bpmn` is a diff tripwire: drift in it is a defect, not a reason
 * to regenerate.
 *
 * The guard clause the fixture exercises (a `throw` branch inside an `if` whose
 * enclosing flow continues past it) is recovered structurally: the terminal
 * prints inside the `if` and the continuation resumes after it, so no jump ever
 * targets the `if`'s synthesized join gateway.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { xmlToIr, irToDsl, astToIr } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  EventDefinition,
  FlowContainer,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import {
  parseShapeBounds,
  assertShapeContainment,
} from './helpers/di-bounds.js';
import { kindOf, subProcess } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-handlers', {
  example: 'order-recovery',
  importPath: true,
  recompile: 'errors',
});

/**
 * The event definition on the trigger start of the first event-handler
 * sub-process, at any container depth, whose definition satisfies `match`.
 * Recurses into plain sub-processes so a nested handler is reachable.
 */
function handlerTriggerDef(
  container: FlowContainer,
  match: (def: EventDefinition | undefined) => boolean,
): EventDefinition | undefined {
  for (const fe of container.flowElements) {
    if (fe.kind !== 'subProcess') continue;
    if (fe.triggeredByEvent === true) {
      const start = fe.flowElements.find((e) => e.kind === 'startEvent');
      const def =
        start?.kind === 'startEvent' ? start.eventDefinition : undefined;
      if (match(def)) return def;
    }
    const nested = handlerTriggerDef(fe, match);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function definitionOf(
  container: FlowContainer,
  id: string,
): EventDefinition | undefined {
  const fe = container.flowElements.find((e) => e.id === id);
  if (fe?.kind === 'endEvent' || fe?.kind === 'intermediateThrowEvent') {
    return fe.eventDefinition;
  }
  return undefined;
}

/**
 * The `errorRef` on the `bpmn:errorEventDefinition` inside the named start or
 * end event, scoped to that element block so the two sites are read separately.
 */
function errorRefOf(xml: string, elementId: string): string | undefined {
  const block = new RegExp(
    `<bpmn:(?:start|end)Event id="${elementId}"[^>]*>([\\s\\S]*?)</bpmn:(?:start|end)Event>`,
  ).exec(xml);
  if (block === null) return undefined;
  return /<bpmn:errorEventDefinition\b[^>]*\berrorRef="([^"]+)"/.exec(
    block[1]!,
  )?.[1];
}

/**
 * A handwritten import-first fixture: a hand-named event sub-process, `camunda:`
 * aliases for the error root message and the catch bindings, and labels that
 * differ from the name humanised from each id, so the importer keeps them.
 */
const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:error id="Error_Boom" name="BOOM" errorCode="BOOM" camunda:errorMessage="It went boom" />
  <bpmn:process id="import-first" name="Import First" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_DoWork</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="DoWork" name="Perform the work" operaton:class="com.example.WorkDelegate">
      <bpmn:incoming>Flow_Begin_DoWork</bpmn:incoming>
      <bpmn:outgoing>Flow_DoWork_Finish</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="Finish">
      <bpmn:incoming>Flow_DoWork_Finish</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_DoWork" sourceRef="Begin" targetRef="DoWork" />
    <bpmn:sequenceFlow id="Flow_DoWork_Finish" sourceRef="DoWork" targetRef="Finish" />
    <bpmn:subProcess id="RecoverBoom" triggeredByEvent="true">
      <bpmn:startEvent id="CaughtBoom">
        <bpmn:outgoing>Flow_CaughtBoom_Cleanup</bpmn:outgoing>
        <bpmn:errorEventDefinition id="ErrDef_1" errorRef="Error_Boom" camunda:errorCodeVariable="code" camunda:errorMessageVariable="text" />
      </bpmn:startEvent>
      <bpmn:serviceTask id="Cleanup" name="Clean things up" operaton:class="com.example.CleanupDelegate">
        <bpmn:incoming>Flow_CaughtBoom_Cleanup</bpmn:incoming>
        <bpmn:outgoing>Flow_Cleanup_Recovered</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Recovered">
        <bpmn:incoming>Flow_Cleanup_Recovered</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_CaughtBoom_Cleanup" sourceRef="CaughtBoom" targetRef="Cleanup" />
      <bpmn:sequenceFlow id="Flow_Cleanup_Recovered" sourceRef="Cleanup" targetRef="Recovered" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

describe('idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃', () => {
  it('the authored throw and emit ids survive verbatim at their correct depth', () => {
    // The throw lives one container down, in the payment sub-process.
    const payment = subProcess(rt.ir3, 'ProcessPayment');
    expect(kindOf(payment, 'PaymentFailed')).toBe('endEvent');
    expect(kindOf(rt.ir3, 'FlagForReview')).toBe('intermediateThrowEvent');
  });

  it('the errorMessages entry survives the round-trip', () => {
    expect(rt.ir3.errorMessages).toEqual([
      {
        code: 'PAYMENT_DECLINED',
        message: 'The payment was declined by the bank',
      },
    ]);
  });

  it('the handler trigger start carries its event definition at every hop', () => {
    const isPaymentError = (def: EventDefinition | undefined): boolean =>
      def?.kind === 'error' && def.errorCode === 'PAYMENT_DECLINED';
    for (const ir of [rt.ir1, rt.ir2, rt.ir3]) {
      const payment = subProcess(ir, 'ProcessPayment');
      const def = handlerTriggerDef(payment, isPaymentError);
      expect(def, `handler error definition missing in a hop`).toBeDefined();
      if (def?.kind === 'error') {
        expect(def.codeVariable).toBe('c');
        expect(def.messageVariable).toBe('m');
      }
    }
  });

  it('the terminal escalation end and the escalation emit keep their definitions', () => {
    expect(definitionOf(rt.ir3, 'FlagForReview')).toEqual({
      kind: 'escalation',
      escalationCode: 'MANUAL_REVIEW',
    });
    const terminal = rt.ir3.flowElements.find(
      (fe) =>
        fe.kind === 'endEvent' &&
        fe.eventDefinition?.kind === 'escalation' &&
        fe.eventDefinition.escalationCode === 'ORDER_ABANDONED',
    );
    expect(terminal, 'terminal throw escalation missing').toBeDefined();
  });
});

describe('DI containment on the generated .bpmn', () => {
  it('exactly one bpmndi:BPMNDiagram is emitted', () => {
    expect(rt.generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  });

  it('every handler shape (and its children) lies strictly inside its parent bounds', () => {
    // An event sub-process is a disconnected node, so the layout library only
    // places its box and children inside the parent when the `isExpanded="true"`
    // stub `irToXml` emits is present. Removing that stub fails this assertion.
    const bounds = parseShapeBounds(rt.generatedXml);

    // Guard against a vacuous pass: the handler shapes must actually be present.
    const payment = subProcess(rt.ir1, 'ProcessPayment');
    const handlerIds = payment.flowElements
      .filter((fe) => fe.kind === 'subProcess')
      .map((fe) => fe.id);
    expect(handlerIds.length).toBeGreaterThan(0);
    for (const id of [...handlerIds, 'CaughtPayment', 'NotifyCustomer']) {
      expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
    }

    // Walk the IR so parent-child membership is authoritative at every depth.
    assertShapeContainment(rt.ir1, bounds, true);
  });
});

describe('root sharing on the frozen .bpmn', () => {
  it('the throw error end event and the on error handler share one bpmn:Error carrying the message', () => {
    const roots = [
      ...rt.frozenXml.matchAll(
        /<bpmn:error id="([^"]+)"[^>]*errorCode="PAYMENT_DECLINED"[^>]*operaton:errorMessage="([^"]+)"/g,
      ),
    ];
    expect(roots).toHaveLength(1);
    const [, rootId, message] = roots[0]!;
    expect(message).toBe('The payment was declined by the bank');

    expect(errorRefOf(rt.frozenXml, 'PaymentFailed')).toBe(rootId);
    expect(errorRefOf(rt.frozenXml, 'CaughtPayment')).toBe(rootId);
  });
});

describe('import-first: a handwritten .bpmn with camunda: aliases round-trips', () => {
  let firstImport: BpmnProcess;
  let firstWarnings: string[];
  let reDesugared: BpmnProcess;
  let importDsl: string;

  beforeAll(async () => {
    const imported = await xmlToIr(IMPORT_FIRST_BPMN);
    firstImport = imported.ir;
    firstWarnings = imported.warnings;
    importDsl = irToDsl(firstImport);
    reDesugared = astToIr(await rt.parseToAst(importDsl));
  });

  it('imports warning-free', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('normalizes the camunda: error message and binding aliases into the DSL', () => {
    // `code` doubles as an ordinary variable name in the catch parameter.
    expect(importDsl).toContain('error "BOOM" message "It went boom"');
    expect(importDsl).toContain('on error "BOOM" (code code, message text) {');
  });

  it('the hand-named handler is re-keyed so the re-desugared IR matches the import', () => {
    // The hand-named event sub-process has no surface id and is re-synthesised
    // on re-desugaring, so the structural re-key collapses the two ids.
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(firstImport));
  });
});
