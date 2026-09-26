import { it, expect } from 'vitest';

import type { EventDefinition } from '@bpmn-script/transform';

import {
  camundaAliasWarning,
  describeImportFirst,
} from './helpers/import-first.js';
import {
  definitionOf,
  handlerTriggerDef,
  subProcess,
} from './helpers/ir-query.js';
import { definitionRefOf, errorRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-handlers', {
  importPath: true,
  recompile: 'errors',
});

// `camunda:` aliases on the error root message and the catch bindings.
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

it('keeps the declarations, the handler trigger at every hop and the escalation throws', () => {
  expect(rt.ir3.errorDecls).toEqual([
    {
      name: 'PAYMENT_DECLINED',
      code: 'PAYMENT_DECLINED',
      message: 'The payment was declined by the bank',
    },
    // A name apart from its code, and a declaration nothing raises or
    // catches: both come back only if the root carries them.
    {
      name: 'GatewayTimeout',
      code: 'gateway.timeout',
      message: 'The payment gateway did not answer',
    },
    {
      name: 'STOCK_UNAVAILABLE',
      code: 'STOCK_UNAVAILABLE',
      message: 'The warehouse cannot fulfil the order',
    },
  ]);
  expect(rt.ir3.escalationDecls).toEqual([
    { name: 'MANUAL_REVIEW', code: 'MANUAL_REVIEW' },
    { name: 'ORDER_ABANDONED', code: 'ORDER_ABANDONED' },
  ]);
  const isPaymentError = (def: EventDefinition | undefined): boolean =>
    def?.kind === 'error' && def.errorCode === 'PAYMENT_DECLINED';
  for (const [label, ir] of rt.hops) {
    expect(
      handlerTriggerDef(subProcess(ir, 'ProcessPayment'), isPaymentError),
      label,
    ).toEqual({
      kind: 'error',
      errorCode: 'PAYMENT_DECLINED',
      codeVariable: 'c',
      messageVariable: 'm',
    });
  }
  expect(definitionOf(rt.ir3, 'FlagForReview')).toEqual({
    kind: 'escalation',
    escalationCode: 'MANUAL_REVIEW',
  });
  expect(
    rt.ir3.flowElements.filter(
      (fe) =>
        fe.kind === 'endEvent' &&
        fe.eventDefinition?.kind === 'escalation' &&
        fe.eventDefinition.escalationCode === 'ORDER_ABANDONED',
    ),
  ).toHaveLength(1);
});

it('the throw error end and the on error handler share one bpmn:Error carrying the message', () => {
  expect(errorRoots(rt.frozenXml, 'PAYMENT_DECLINED')).toEqual([
    { id: expect.any(String), message: 'The payment was declined by the bank' },
  ]);
  const [{ id }] = errorRoots(rt.frozenXml, 'PAYMENT_DECLINED');
  expect(definitionRefOf(rt.frozenXml, 'PaymentFailed', 'error')).toBe(id);
  expect(definitionRefOf(rt.frozenXml, 'CaughtPayment', 'error')).toBe(id);
});

describeImportFirst(
  'a handwritten .bpmn with camunda: aliases round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('normalizes the camunda: error message and binding aliases into the DSL', () => {
      expect(first.dsl).toContain('error BOOM(message: "It went boom")');
      expect(first.dsl).toContain(
        'on error(BOOM, code: code, message: text) {',
      );
    });
  },
  [camundaAliasWarning('import-first')],
);
