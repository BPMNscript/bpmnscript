import { it, expect } from 'vitest';

import type { EventDefinition, FlowContainer } from '@bpmn-script/transform';

import { describeImportFirst } from './helpers/import-first.js';
import {
  definitionOf,
  handlerTriggerDef,
  handlerTriggerDefs,
  kindOf,
  subProcess,
} from './helpers/ir-query.js';
import { definitionRefOf, messageRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-triggers', {
  importPath: true,
  recompile: 'clean',
});

function timerExpressions(container: FlowContainer): string[] {
  return handlerTriggerDefs(container)
    .flatMap((def) => (def?.kind === 'timer' ? [def.expression] : []))
    .sort();
}

// One `bpmn:Signal` root referenced by the intermediate throw and the end event.
const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first_triggers" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:signal id="Signal_Sent" name="ParcelDispatched" />
  <bpmn:process id="parcel-tracking" name="Parcel Tracking" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_Dispatch</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Dispatch" name="Send the parcel out" operaton:class="com.example.DispatchDelegate">
      <bpmn:incoming>Flow_Begin_Dispatch</bpmn:incoming>
      <bpmn:outgoing>Flow_Dispatch_Broadcast</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:intermediateThrowEvent id="Broadcast">
      <bpmn:incoming>Flow_Dispatch_Broadcast</bpmn:incoming>
      <bpmn:outgoing>Flow_Broadcast_Done</bpmn:outgoing>
      <bpmn:signalEventDefinition signalRef="Signal_Sent" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="Done">
      <bpmn:incoming>Flow_Broadcast_Done</bpmn:incoming>
      <bpmn:signalEventDefinition signalRef="Signal_Sent" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_Dispatch" sourceRef="Begin" targetRef="Dispatch" />
    <bpmn:sequenceFlow id="Flow_Dispatch_Broadcast" sourceRef="Dispatch" targetRef="Broadcast" />
    <bpmn:sequenceFlow id="Flow_Broadcast_Done" sourceRef="Broadcast" targetRef="Done" />
    <bpmn:subProcess id="WatchStock" triggeredByEvent="true">
      <bpmn:startEvent id="LowStock">
        <bpmn:outgoing>Flow_LowStock_Reorder</bpmn:outgoing>
        <bpmn:conditionalEventDefinition>
          <bpmn:condition xsi:type="bpmn:tFormalExpression">\${stockLevel &lt; 5}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Reorder" name="Reorder the item" operaton:class="com.example.ReorderDelegate">
        <bpmn:incoming>Flow_LowStock_Reorder</bpmn:incoming>
        <bpmn:outgoing>Flow_Reorder_Reordered</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Reordered">
        <bpmn:incoming>Flow_Reorder_Reordered</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_LowStock_Reorder" sourceRef="LowStock" targetRef="Reorder" />
      <bpmn:sequenceFlow id="Flow_Reorder_Reordered" sourceRef="Reorder" targetRef="Reordered" />
    </bpmn:subProcess>
    <bpmn:subProcess id="RemindLate" triggeredByEvent="true">
      <bpmn:startEvent id="Deadline">
        <bpmn:outgoing>Flow_Deadline_Chase</bpmn:outgoing>
        <bpmn:timerEventDefinition>
          <bpmn:timeDate xsi:type="bpmn:tFormalExpression">2026-09-01T08:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Chase" name="Chase the courier" operaton:class="com.example.ChaseDelegate">
        <bpmn:incoming>Flow_Deadline_Chase</bpmn:incoming>
        <bpmn:outgoing>Flow_Chase_Chased</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Chased">
        <bpmn:incoming>Flow_Chase_Chased</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_Deadline_Chase" sourceRef="Deadline" targetRef="Chase" />
      <bpmn:sequenceFlow id="Flow_Chase_Chased" sourceRef="Chase" targetRef="Chased" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

it('keeps the signal throws, and every handler trigger at every hop', () => {
  // `emit signal` continues the path, `throw signal` ends it.
  const signal = { kind: 'signal', signalName: 'OrderFulfilled' };
  expect(kindOf(rt.ir3, 'Notify')).toBe('intermediateThrowEvent');
  expect(kindOf(rt.ir3, 'Announce')).toBe('endEvent');
  expect(definitionOf(rt.ir3, 'Notify')).toEqual(signal);
  expect(definitionOf(rt.ir3, 'Announce')).toEqual(signal);
  const isConditional = (def: EventDefinition | undefined): boolean =>
    def?.kind === 'conditional';
  for (const [label, ir] of rt.hops) {
    expect(
      handlerTriggerDef(subProcess(ir, 'FulfilOrder'), isConditional),
      label,
    ).toEqual({ kind: 'conditional', condition: '${stockLevel < 5}' });
    expect(timerExpressions(ir), label).toEqual([
      '2026-08-01T09:00:00',
      'PT2H',
    ]);
  }
  expect(handlerTriggerDef(rt.ir3, (d) => d?.kind === 'message')).toEqual({
    kind: 'message',
    messageName: 'OrderCancelled',
  });
});

it('shares one bpmn:Signal between the handler, the emit and the throw, and gives the message handler its root', () => {
  const signals = [
    ...rt.frozenXml.matchAll(/<bpmn:signal id="([^"]+)" name="([^"]+)"/g),
  ].map(([, id, name]) => ({ id, name }));
  expect(signals).toEqual([{ id: expect.any(String), name: 'OrderFulfilled' }]);
  for (const id of ['FulfilledStart', 'Notify', 'Announce']) {
    expect(definitionRefOf(rt.frozenXml, id, 'signal'), id).toBe(
      signals[0]!.id,
    );
  }
  expect(messageRoots(rt.frozenXml).map((root) => root.name)).toEqual([
    'OrderCancelled',
  ]);
});

describeImportFirst(
  'a handwritten .bpmn throwing one signal twice round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('recovers each trigger payload into the DSL, both broadcasts on the one signal', () => {
      expect(first.dsl).toContain('emit signal Broadcast("ParcelDispatched")');
      expect(first.dsl).toContain('throw signal Done("ParcelDispatched")');
      expect(first.dsl).toContain('on timer(at: "2026-09-01T08:00:00") {');
      expect(first.dsl).toContain('on condition(stockLevel < 5) {');
      const signal = { kind: 'signal', signalName: 'ParcelDispatched' };
      expect(definitionOf(first.ir, 'Broadcast')).toEqual(signal);
      expect(definitionOf(first.ir, 'Done')).toEqual(signal);
    });
  },
);
