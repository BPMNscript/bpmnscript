// Why the restructured DSL is asserted validator-clean: the fixture avoids the
// early-exit-inside-`if` shape that degrades a jump into a goto onto an unnamed
// synthesized join, and every throw and emit is named, so the printer emits the
// authored id instead of a `Throw_<coord>` one that trips the reserved-name check.

import { describe, it, expect } from 'vitest';

import type { EventDefinition, FlowContainer } from '@bpmn-script/transform';

import {
  describeDiContainment,
  describeSingleDiagram,
} from './helpers/di-bounds.js';
import { describeImportFirst } from './helpers/import-first.js';
import {
  definitionOf,
  handlerTriggerDef,
  handlerTriggerDefs,
  kindOf,
  subProcess,
} from './helpers/ir-query.js';
import { definitionRefOf } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-triggers', {
  example: 'order-reminder',
  importPath: true,
  recompile: 'clean',
});

function timerExpressions(container: FlowContainer): string[] {
  return handlerTriggerDefs(container)
    .flatMap((def) => (def?.kind === 'timer' ? [def.expression] : []))
    .sort();
}

// Handwritten import-first. Two `bpmn:Signal` roots share a name but are
// referenced by different elements, one by the intermediate throw and one by the
// end event. Every task label differs from the name humanized from its id, so
// the importer keeps it.
const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first_triggers" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:signal id="Signal_Sent_A" name="ParcelDispatched" />
  <bpmn:signal id="Signal_Sent_B" name="ParcelDispatched" />
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
      <bpmn:signalEventDefinition signalRef="Signal_Sent_A" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="Done">
      <bpmn:incoming>Flow_Broadcast_Done</bpmn:incoming>
      <bpmn:signalEventDefinition signalRef="Signal_Sent_B" />
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

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it('the authored throw and emit ids survive verbatim at process level', () => {
    // `emit signal` continues the path, `throw signal` ends it.
    expect(kindOf(rt.ir3, 'Notify')).toBe('intermediateThrowEvent');
    expect(kindOf(rt.ir3, 'Announce')).toBe('endEvent');
    expect(definitionOf(rt.ir3, 'Notify')).toEqual({
      kind: 'signal',
      signalName: 'OrderFulfilled',
    });
    expect(definitionOf(rt.ir3, 'Announce')).toEqual({
      kind: 'signal',
      signalName: 'OrderFulfilled',
    });
  });

  it('the conditional handler condition survives as the same expression at every hop', () => {
    const isConditional = (def: EventDefinition | undefined): boolean =>
      def?.kind === 'conditional';
    for (const ir of [rt.ir1, rt.ir2, rt.ir3]) {
      const def = handlerTriggerDef(
        subProcess(ir, 'FulfilOrder'),
        isConditional,
      );
      expect(def, 'conditional handler missing in a hop').toBeDefined();
      if (def?.kind === 'conditional') {
        expect(def.condition).toBe('${stockLevel < 5}');
      }
    }
  });

  it('the timer expressions survive verbatim at every hop', () => {
    for (const ir of [rt.ir1, rt.ir2, rt.ir3]) {
      expect(timerExpressions(ir)).toEqual(['2026-08-01T09:00:00', 'PT2H']);
    }
  });

  it('the message handler keeps its correlation name', () => {
    const def = handlerTriggerDef(rt.ir3, (d) => d?.kind === 'message');
    expect(def).toEqual({ kind: 'message', messageName: 'OrderCancelled' });
  });
});

describeSingleDiagram(rt);

describeDiContainment(
  rt,
  () => {
    const handlerIds = subProcess(rt.ir1, 'FulfilOrder')
      .flowElements.filter((fe) => fe.kind === 'subProcess')
      .map((fe) => fe.id);
    expect(handlerIds.length).toBeGreaterThan(0);
    return handlerIds;
  },
  'generated',
);

describe('root sharing on the frozen .bpmn', () => {
  it('the on signal handler, the emit, and the throw share one bpmn:Signal', () => {
    const signals = [
      ...rt.frozenXml.matchAll(/<bpmn:signal id="([^"]+)" name="([^"]+)"/g),
    ];
    expect(signals).toHaveLength(1);
    const [, signalId, signalName] = signals[0]!;
    expect(signalName).toBe('OrderFulfilled');

    expect(definitionRefOf(rt.frozenXml, 'FulfilledStart', 'signal')).toBe(
      signalId,
    );
    expect(definitionRefOf(rt.frozenXml, 'Notify', 'signal')).toBe(signalId);
    expect(definitionRefOf(rt.frozenXml, 'Announce', 'signal')).toBe(signalId);
  });

  it('there is exactly one root per distinct message and signal name', () => {
    expect(rt.frozenXml.match(/<bpmn:message id="[^"]+"/g)).toHaveLength(1);
    expect(rt.frozenXml.match(/<bpmn:signal id="[^"]+"/g)).toHaveLength(1);
  });
});

describeImportFirst(
  'a handwritten .bpmn with two same-name signals round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('recovers each trigger payload into the DSL surface', () => {
      expect(first.dsl).toContain('emit signal Broadcast "ParcelDispatched"');
      expect(first.dsl).toContain('throw signal Done "ParcelDispatched"');
      expect(first.dsl).toContain('on timer at "2026-09-01T08:00:00" {');
      expect(first.dsl).toContain('on condition (stockLevel < 5) {');
    });

    it('both broadcasts resolve to the one collapsed signal name', () => {
      const collapsed = { kind: 'signal', signalName: 'ParcelDispatched' };
      expect(definitionOf(first.ir, 'Broadcast')).toEqual(collapsed);
      expect(definitionOf(first.ir, 'Done')).toEqual(collapsed);
    });
  },
);
