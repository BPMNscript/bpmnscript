// Why the restructured DSL stays validator-clean: every throw and emit is
// named, so the printer emits the authored id instead of a `Throw_<coord>` one
// that would trip the reserved-name check, and the guards read variables
// declared on the start form. The `var compensation` declaration does not
// survive the round trip, but its only reference sits inside an opaque service
// expression the validator never parses.

import { describe, it, expect } from 'vitest';

import type { EventDefinition } from '@bpmn-script/transform';

import {
  describeDiContainment,
  describeSingleDiagram,
} from './helpers/di-bounds.js';
import { describeImportFirst } from './helpers/import-first.js';
import {
  definitionOf,
  elementById,
  handlerTriggerDef,
  subProcess,
} from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('compensation', {
  example: 'compensating-saga',
  importPath: true,
  recompile: 'clean',
});

const isCompensation = (def: EventDefinition | undefined): boolean =>
  def?.kind === 'compensation';

function startEventOpenTag(xml: string, id: string): string | undefined {
  return new RegExp(`<bpmn:startEvent id="${id}"[^>]*>`).exec(xml)?.[0];
}

// Handwritten import-first. The compensation end event carries an explicit
// `waitForCompletion="true"`, the moddle default, accepted on import and then
// dropped as unmodeled. Every task label differs from the name humanized from
// its id, so the importer keeps it.
const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first_compensation" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="warehouse-fulfilment" name="Warehouse Fulfilment" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_Pick</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:subProcess id="Pick" name="Pick the whole order">
      <bpmn:incoming>Flow_Begin_Pick</bpmn:incoming>
      <bpmn:outgoing>Flow_Pick_Raise</bpmn:outgoing>
      <bpmn:startEvent id="PickBegin">
        <bpmn:outgoing>Flow_PickBegin_Grab</bpmn:outgoing>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Grab" name="Take the item off the shelf" operaton:class="com.example.GrabDelegate">
        <bpmn:incoming>Flow_PickBegin_Grab</bpmn:incoming>
        <bpmn:outgoing>Flow_Grab_PickDone</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="PickDone">
        <bpmn:incoming>Flow_Grab_PickDone</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:subProcess id="ReturnItems" triggeredByEvent="true">
        <bpmn:startEvent id="UndoPick">
          <bpmn:outgoing>Flow_UndoPick_PutBack</bpmn:outgoing>
          <bpmn:compensateEventDefinition />
        </bpmn:startEvent>
        <bpmn:serviceTask id="PutBack" name="Return the item to the shelf" operaton:class="com.example.PutBackDelegate">
          <bpmn:incoming>Flow_UndoPick_PutBack</bpmn:incoming>
          <bpmn:outgoing>Flow_PutBack_UndoDone</bpmn:outgoing>
        </bpmn:serviceTask>
        <bpmn:endEvent id="UndoDone">
          <bpmn:incoming>Flow_PutBack_UndoDone</bpmn:incoming>
        </bpmn:endEvent>
        <bpmn:sequenceFlow id="Flow_UndoPick_PutBack" sourceRef="UndoPick" targetRef="PutBack" />
        <bpmn:sequenceFlow id="Flow_PutBack_UndoDone" sourceRef="PutBack" targetRef="UndoDone" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_PickBegin_Grab" sourceRef="PickBegin" targetRef="Grab" />
      <bpmn:sequenceFlow id="Flow_Grab_PickDone" sourceRef="Grab" targetRef="PickDone" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Raise">
      <bpmn:incoming>Flow_Pick_Raise</bpmn:incoming>
      <bpmn:outgoing>Flow_Raise_GiveUp</bpmn:outgoing>
      <bpmn:compensateEventDefinition />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="GiveUp">
      <bpmn:incoming>Flow_Raise_GiveUp</bpmn:incoming>
      <bpmn:compensateEventDefinition waitForCompletion="true" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_Pick" sourceRef="Begin" targetRef="Pick" />
    <bpmn:sequenceFlow id="Flow_Pick_Raise" sourceRef="Pick" targetRef="Raise" />
    <bpmn:sequenceFlow id="Flow_Raise_GiveUp" sourceRef="Raise" targetRef="GiveUp" />
  </bpmn:process>
</bpmn:definitions>`;

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it('the authored emit and throw ids survive verbatim through their handlers', () => {
    // `emit compensation` continues the path, `throw compensation` ends it.
    expect(elementById(rt.ir3, 'Undo').kind).toBe('intermediateThrowEvent');
    expect(elementById(rt.ir3, 'CancelAll').kind).toBe('endEvent');
    expect(definitionOf(rt.ir3, 'Undo')).toEqual({ kind: 'compensation' });
    expect(definitionOf(rt.ir3, 'CancelAll')).toEqual({ kind: 'compensation' });
  });

  it('both undo-block handler starts carry a compensation trigger at every hop', () => {
    for (const ir of [rt.ir1, rt.ir2, rt.ir3]) {
      for (const host of ['BookFlight', 'BookHotel']) {
        const def = handlerTriggerDef(subProcess(ir, host), isCompensation);
        expect(def, `undo block missing in ${host} at a hop`).toEqual({
          kind: 'compensation',
        });
      }
    }
  });
});

describeSingleDiagram(rt);

describeDiContainment(
  rt,
  () =>
    ['BookFlight', 'BookHotel'].flatMap((host) => {
      const handlerIds = subProcess(rt.ir1, host)
        .flowElements.filter(
          (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
        )
        .map((fe) => fe.id);
      expect(handlerIds.length).toBeGreaterThan(0);
      return handlerIds;
    }),
  'generated',
);

describe('compensation shape pins on the frozen .bpmn', () => {
  it('emits no compensation root element (only the error and escalation roots exist)', () => {
    // Compensation is payload-less, so it contributes no document-level root.
    expect(rt.frozenXml).not.toMatch(/<bpmn:compensation\b/);
    expect(rt.frozenXml.match(/<bpmn:error id="[^"]+"/g)).toHaveLength(1);
    expect(rt.frozenXml.match(/<bpmn:escalation id="[^"]+"/g)).toHaveLength(1);
  });

  it('every bpmn:compensateEventDefinition is attribute-less', () => {
    const all =
      rt.frozenXml.match(/<bpmn:compensateEventDefinition\b[^>]*>/g) ?? [];
    expect(all).toHaveLength(4);
    for (const tag of all) {
      expect(tag).toBe('<bpmn:compensateEventDefinition />');
    }
  });

  it('each undo block is a triggeredByEvent sub-process whose start is interrupting', () => {
    // Compensation always interrupts, so the serializer drops the default and
    // the trigger start carries no interrupting flag.
    for (const host of ['BookFlight', 'BookHotel']) {
      const handler = subProcess(rt.ir1, host).flowElements.find(
        (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
      );
      expect(handler?.kind).toBe('subProcess');
      if (handler?.kind === 'subProcess') {
        const start = handler.flowElements.find((e) => e.kind === 'startEvent');
        expect(
          start?.kind === 'startEvent' && start.isInterrupting,
        ).toBeUndefined();
      }
    }

    for (const startId of ['CancelFlightStart', 'CancelHotelStart']) {
      const tag = startEventOpenTag(rt.frozenXml, startId);
      expect(tag, `start ${startId} not found`).toBeDefined();
      expect(tag).not.toContain('isInterrupting');
    }
  });
});

describeImportFirst(
  'a handwritten .bpmn with an undo block round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('recovers each compensation surface into the DSL', () => {
      expect(first.dsl).toContain('subprocess Pick "Pick the whole order" {');
      expect(first.dsl).toContain('on compensation {');
      expect(first.dsl).toContain('emit compensation Raise');
      expect(first.dsl).toContain('throw compensation GiveUp');
    });

    it('the emit and throw resolve to the payload-less compensation kind', () => {
      expect(definitionOf(first.ir, 'Raise')).toEqual({ kind: 'compensation' });
      expect(definitionOf(first.ir, 'GiveUp')).toEqual({
        kind: 'compensation',
      });
    });
  },
);
