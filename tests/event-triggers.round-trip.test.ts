// Why the restructured DSL is asserted validator-clean: the fixture avoids the
// early-exit-inside-`if` shape that degrades a jump into a goto onto an unnamed
// synthesised join, and every throw and emit is named, so the printer emits the
// authored id instead of a `Throw_<coord>` one that trips the reserved-name check.

import { describe, it, expect, beforeAll } from 'vitest';

import { xmlToIr, irToDsl, astToIr } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  EventDefinition,
  FlowContainer,
  ImportWarning,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { describeDiContainment } from './helpers/di-bounds.js';
import {
  definitionOf,
  handlerTriggerDef,
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
  const out: string[] = [];
  for (const fe of container.flowElements) {
    if (fe.kind !== 'subProcess') continue;
    if (fe.triggeredByEvent === true) {
      const start = fe.flowElements.find((e) => e.kind === 'startEvent');
      const def =
        start?.kind === 'startEvent' ? start.eventDefinition : undefined;
      if (def?.kind === 'timer') out.push(def.expression);
    }
    out.push(...timerExpressions(fe));
  }
  return out.sort();
}

// Handwritten import-first. Two `bpmn:Signal` roots share a name but are
// referenced by different elements, one by the intermediate throw and one by the
// end event. Every task label differs from the name humanised from its id, so
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

describe('idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃', () => {
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

describe('DI containment on the generated .bpmn', () => {
  it('exactly one bpmndi:BPMNDiagram is emitted', () => {
    expect(rt.generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  });
});

// Named so the walk cannot pass on a tree with nothing nested in it.
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

describe('import-first: a handwritten .bpmn with two same-name signals round-trips', () => {
  let firstImport: BpmnProcess;
  let firstWarnings: ImportWarning[];
  let reDesugared: BpmnProcess;
  let importDsl: string;

  beforeAll(async () => {
    const imported = await xmlToIr(IMPORT_FIRST_BPMN);
    firstImport = imported.ir;
    firstWarnings = imported.warnings;
    importDsl = irToDsl(firstImport);
    reDesugared = astToIr(await rt.parseToAst(importDsl));
  });

  it('imports warning-free (the two same-name signal roots collapse silently)', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('recovers each trigger payload into the DSL surface', () => {
    expect(importDsl).toContain('emit signal Broadcast "ParcelDispatched"');
    expect(importDsl).toContain('throw signal Done "ParcelDispatched"');
    expect(importDsl).toContain('on timer at "2026-09-01T08:00:00" {');
    expect(importDsl).toContain('on condition (stockLevel < 5) {');
  });

  it('both broadcasts resolve to the one collapsed signal name', () => {
    expect(definitionOf(firstImport, 'Broadcast')).toEqual({
      kind: 'signal',
      signalName: 'ParcelDispatched',
    });
    expect(definitionOf(firstImport, 'Done')).toEqual({
      kind: 'signal',
      signalName: 'ParcelDispatched',
    });
  });

  it('the hand-named handlers are re-keyed so the re-desugared IR matches the import', () => {
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(firstImport));
  });
});
