import { it, expect } from 'vitest';

import type { EventDefinition } from '@bpmn-script/transform';

import { describeImportFirst } from './helpers/import-first.js';
import {
  definitionOf,
  elementById,
  handlerTriggerDef,
  subProcess,
} from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('compensation', {
  importPath: true,
  recompile: 'clean',
});

const isCompensation = (def: EventDefinition | undefined): boolean =>
  def?.kind === 'compensation';

function startEventOpenTag(xml: string, id: string): string | undefined {
  return new RegExp(`<bpmn:startEvent id="${id}"[^>]*>`).exec(xml)?.[0];
}

// `waitForCompletion="true"` is the moddle default, so import drops it.
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

it('keeps the emit, the throw and both undo blocks as payload-less compensation at every hop', () => {
  expect(elementById(rt.ir3, 'Undo').kind).toBe('intermediateThrowEvent');
  expect(elementById(rt.ir3, 'CancelAll').kind).toBe('endEvent');
  expect(definitionOf(rt.ir3, 'Undo')).toEqual({ kind: 'compensation' });
  expect(definitionOf(rt.ir3, 'CancelAll')).toEqual({ kind: 'compensation' });
  for (const [label, ir] of rt.hops) {
    for (const host of ['BookFlight', 'BookHotel']) {
      const def = handlerTriggerDef(subProcess(ir, host), isCompensation);
      expect(def, `${host} in ${label}`).toEqual({ kind: 'compensation' });
    }
  }
});

it('writes compensation without a root, an attribute or an interrupting flag', () => {
  expect(rt.frozenXml).not.toMatch(/<bpmn:compensation\b/);
  expect(rt.frozenXml.match(/<bpmn:error id="[^"]+"/g)).toHaveLength(1);
  expect(rt.frozenXml.match(/<bpmn:escalation id="[^"]+"/g)).toHaveLength(1);
  expect(
    rt.frozenXml.match(/<bpmn:compensateEventDefinition\b[^>]*>/g),
  ).toEqual(Array<string>(4).fill('<bpmn:compensateEventDefinition />'));
  // Compensation always interrupts, so the default is not written.
  for (const startId of ['CancelFlightStart', 'CancelHotelStart']) {
    expect(startEventOpenTag(rt.frozenXml, startId)).toBe(
      `<bpmn:startEvent id="${startId}">`,
    );
  }
});

describeImportFirst(
  'a handwritten .bpmn with an undo block round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('recovers each compensation surface into the DSL', () => {
      expect(first.dsl).toContain(
        'subprocess Pick(label: "Pick the whole order") {',
      );
      expect(first.dsl).toContain('on compensation {');
      expect(first.dsl).toContain('emit compensation Raise');
      expect(first.dsl).toContain('throw compensation GiveUp');
      expect(definitionOf(first.ir, 'Raise')).toEqual({ kind: 'compensation' });
      expect(definitionOf(first.ir, 'GiveUp')).toEqual({
        kind: 'compensation',
      });
    });
  },
);
