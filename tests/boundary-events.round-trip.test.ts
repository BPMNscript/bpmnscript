import { it, expect } from 'vitest';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

import { boundsOf, parseShapeBounds } from './helpers/di-bounds.js';
import type { Bounds } from './helpers/di-bounds.js';
import { describeImportFirst } from './helpers/import-first.js';
import { kindOf, subProcess } from './helpers/ir-query.js';
import {
  definitionRefOf,
  errorRoots,
  idsOfTag,
  messageRoots,
} from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('boundary-events', {
  importPath: true,
  recompile: 'errors',
});

type BoundaryEvent = Extract<FlowElement, { kind: 'boundaryEvent' }>;

function boundaryEvents(container: FlowContainer): BoundaryEvent[] {
  return container.flowElements.filter(
    (fe): fe is BoundaryEvent => fe.kind === 'boundaryEvent',
  );
}

// Everything but the id, whose positional suffix is not a structural fact.
function attachmentSignature(boundary: BoundaryEvent): string {
  const def = boundary.eventDefinition;
  const payload =
    def.kind === 'error'
      ? (def.errorCode ?? '<catch-all>')
      : def.kind === 'escalation'
        ? (def.escalationCode ?? '<catch-all>')
        : def.kind === 'message'
          ? def.messageName
          : def.kind === 'signal'
            ? def.signalName
            : def.kind === 'timer'
              ? `${def.timerKind} ${def.expression}`
              : def.kind === 'conditional'
                ? def.condition
                : '<none>';
  const cancels =
    boundary.cancelActivity === false ? 'alongside' : 'interrupting';
  return `${boundary.attachedToRef} ${def.kind} ${payload} ${cancels}`;
}

function attachmentSignatures(container: FlowContainer): string[] {
  return boundaryEvents(container).map(attachmentSignature).sort();
}

// One per host kind a boundary can attach to.
const EXPECTED_ATTACHMENTS = [
  'BookCarrier signal CarrierStrike interrupting',
  'ChargePostage error PAYMENT_DECLINED interrupting',
  'CheckAddress message AddressVerified interrupting',
  'CheckAddress timer duration PT4H alongside',
  'ComputeShipping timer duration PT1H alongside',
  'HandOverParcel conditional ${weight > 30} alongside',
  'PackGoods error ADDRESS_REJECTED interrupting',
  'PackGoods escalation OVERSIZED_PARCEL alongside',
  'PrintLabel message ExpediteRequested interrupting',
].sort();

// bpmn-auto-layout spreads `n` attachers along the host's bottom edge at
// `x + width * i/(n+1)`.
function assertAttachedToHost(
  bounds: Map<string, Bounds>,
  hostId: string,
  boundaryIds: readonly string[],
): void {
  const host = boundsOf(bounds, hostId);
  const attachers = boundaryIds
    .map((id) => ({ id, box: boundsOf(bounds, id) }))
    .sort((a, b) => a.box.x - b.box.x);

  attachers.forEach(({ id, box }, index) => {
    expect(
      box.y + box.height / 2,
      `${id} is not centered on the bottom edge of ${hostId}`,
    ).toBeCloseTo(host.y + host.height, 3);
    expect(
      box.x + box.width / 2,
      `${id} is not distributed along the bottom edge of ${hostId}`,
    ).toBeCloseTo(
      host.x + (host.width * (index + 1)) / (attachers.length + 1),
      3,
    );
  });
}

// Boundary ids the id template would never produce.
const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_crate_handover" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:error id="Error_Torn" name="TORN_BOX" errorCode="TORN_BOX" />
  <bpmn:error id="Error_Missing" name="MISSING_ITEM" errorCode="MISSING_ITEM" />
  <bpmn:process id="crate-handover" name="Crate Handover" isExecutable="true">
    <bpmn:startEvent id="CrateArrived">
      <bpmn:outgoing>Flow_CrateArrived_InspectCrate</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="InspectCrate" name="Inspect the crate" operaton:assignee="demo">
      <bpmn:incoming>Flow_CrateArrived_InspectCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_InspectCrate_StoreCrate</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:serviceTask id="StoreCrate" name="Store the crate" operaton:class="com.example.dispatch.StoreDelegate">
      <bpmn:incoming>Flow_InspectCrate_StoreCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_StoreCrate_CrateAccepted</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="CrateAccepted">
      <bpmn:incoming>Flow_StoreCrate_CrateAccepted</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="BoxTorn" attachedToRef="InspectCrate">
      <bpmn:outgoing>Flow_BoxTorn_RepackCrate</bpmn:outgoing>
      <bpmn:errorEventDefinition id="ErrDef_Torn" errorRef="Error_Torn" />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="RepackCrate" name="Repack the crate" operaton:class="com.example.dispatch.RepackDelegate">
      <bpmn:incoming>Flow_BoxTorn_RepackCrate</bpmn:incoming>
      <bpmn:outgoing>Flow_RepackCrate_CrateRepacked</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="CrateRepacked">
      <bpmn:incoming>Flow_RepackCrate_CrateRepacked</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="ItemMissing" attachedToRef="InspectCrate">
      <bpmn:outgoing>Flow_ItemMissing_ReorderItem</bpmn:outgoing>
      <bpmn:errorEventDefinition id="ErrDef_Missing" errorRef="Error_Missing" />
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="ReorderItem" name="Reorder the missing item" operaton:class="com.example.dispatch.ReorderDelegate">
      <bpmn:incoming>Flow_ItemMissing_ReorderItem</bpmn:incoming>
      <bpmn:outgoing>Flow_ReorderItem_ItemReordered</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="ItemReordered">
      <bpmn:incoming>Flow_ReorderItem_ItemReordered</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:boundaryEvent id="CrateOverdue" cancelActivity="false" attachedToRef="StoreCrate">
      <bpmn:outgoing>Flow_CrateOverdue_ChaseStorage</bpmn:outgoing>
      <bpmn:timerEventDefinition id="TimerDef_1">
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:serviceTask id="ChaseStorage" name="Chase the storage team" operaton:class="com.example.dispatch.ChaseDelegate">
      <bpmn:incoming>Flow_CrateOverdue_ChaseStorage</bpmn:incoming>
      <bpmn:outgoing>Flow_ChaseStorage_StorageChased</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="StorageChased">
      <bpmn:incoming>Flow_ChaseStorage_StorageChased</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_CrateArrived_InspectCrate" sourceRef="CrateArrived" targetRef="InspectCrate" />
    <bpmn:sequenceFlow id="Flow_InspectCrate_StoreCrate" sourceRef="InspectCrate" targetRef="StoreCrate" />
    <bpmn:sequenceFlow id="Flow_StoreCrate_CrateAccepted" sourceRef="StoreCrate" targetRef="CrateAccepted" />
    <bpmn:sequenceFlow id="Flow_BoxTorn_RepackCrate" sourceRef="BoxTorn" targetRef="RepackCrate" />
    <bpmn:sequenceFlow id="Flow_RepackCrate_CrateRepacked" sourceRef="RepackCrate" targetRef="CrateRepacked" />
    <bpmn:sequenceFlow id="Flow_ItemMissing_ReorderItem" sourceRef="ItemMissing" targetRef="ReorderItem" />
    <bpmn:sequenceFlow id="Flow_ReorderItem_ItemReordered" sourceRef="ReorderItem" targetRef="ItemReordered" />
    <bpmn:sequenceFlow id="Flow_CrateOverdue_ChaseStorage" sourceRef="CrateOverdue" targetRef="ChaseStorage" />
    <bpmn:sequenceFlow id="Flow_ChaseStorage_StorageChased" sourceRef="ChaseStorage" targetRef="StorageChased" />
  </bpmn:process>
</bpmn:definitions>`;

it("keeps each boundary's host, trigger, payload and cancelActivity at every hop, and the escape chain's rejoin and if", () => {
  for (const [label, ir] of rt.hops) {
    expect(attachmentSignatures(ir), label).toEqual(EXPECTED_ATTACHMENTS);
  }
  // The escalation is thrown inside the sub-process its boundary watches.
  expect(kindOf(subProcess(rt.ir3, 'PackGoods'), 'Oversized')).toBe(
    'intermediateThrowEvent',
  );
  // Handler body and main flow share a container, so the goto is a real edge.
  expect(
    rt.ir3.sequenceFlows.find((sf) => sf.sourceRef === 'MarkAddressVerified')
      ?.targetRef,
  ).toBe('PackGoods');
  // The boundary is wired to the CFG's virtual entry, so the split in its
  // escape chain has an immediate dominator and restructures as an if.
  expect(rt.dslPrime).toContain('if (parcelValue > 500) {');
});

it('lays every boundary centered on and spread along its host lower edge, the sub-process host at its expanded size', () => {
  const bounds = parseShapeBounds(rt.generatedXml);
  const hosts: Record<string, string[]> = {
    CheckAddress: [
      'Boundary_CheckAddress_message',
      'Boundary_CheckAddress_timer',
    ],
    PackGoods: ['Boundary_PackGoods_error', 'Boundary_PackGoods_escalation'],
    BookCarrier: ['Boundary_BookCarrier_signal'],
    HandOverParcel: ['Boundary_HandOverParcel_condition'],
    ComputeShipping: ['Boundary_ComputeShipping_timer'],
    ChargePostage: ['Boundary_ChargePostage_error'],
    PrintLabel: ['Boundary_PrintLabel_message'],
  };
  for (const [host, ids] of Object.entries(hosts)) {
    assertAttachedToHost(bounds, host, ids);
  }
  // The host's bounds come from its laid-out children.
  const host = boundsOf(bounds, 'PackGoods');
  const child = boundsOf(bounds, 'PickItems');
  expect(host.width).toBeGreaterThan(child.width);
  expect(host.height).toBeGreaterThan(child.height);
});

// [title, the one root's ids, definition kind, every element referencing it]
const SHARED_ROOTS: readonly [
  string,
  (xml: string) => string[],
  'error' | 'escalation' | 'message' | 'signal',
  readonly string[],
][] = [
  [
    'the boundary signal and the host-less handler signal share one bpmn:Signal',
    (xml) => idsOfTag(xml, 'signal'),
    'signal',
    ['Boundary_BookCarrier_signal', 'StrikeNoted'],
  ],
  [
    'the escalation thrown inside the sub-process and the one caught on its boundary share one bpmn:Escalation',
    (xml) => idsOfTag(xml, 'escalation'),
    'escalation',
    ['Oversized', 'Boundary_PackGoods_escalation'],
  ],
  [
    'the error a boundary catches gets a root carrying its declared message',
    (xml) => {
      const roots = errorRoots(xml, 'PAYMENT_DECLINED');
      expect(roots.map((r) => r.message)).toEqual([
        'The payment gateway declined the charge',
      ]);
      return roots.map((r) => r.id);
    },
    'error',
    ['Boundary_ChargePostage_error'],
  ],
  [
    'the message a boundary correlates on gets its own bpmn:Message root',
    (xml) =>
      messageRoots(xml)
        .filter((r) => r.name === 'ExpediteRequested')
        .map((r) => r.id),
    'message',
    ['Boundary_PrintLabel_message'],
  ],
];

it.each(SHARED_ROOTS)('%s', (_title, rootsOf, definition, referrers) => {
  const roots = rootsOf(rt.frozenXml);
  expect(roots).toHaveLength(1);
  for (const id of referrers) {
    expect(definitionRefOf(rt.frozenXml, id, definition), id).toBe(roots[0]);
  }
});

describeImportFirst(
  'a handwritten .bpmn with hand-named boundary ids round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('prints each boundary as a handler on its host, re-synthesizing host-derived ids with the pairing intact', () => {
      expect(first.dsl).toContain('on InspectCrate: error(TORN_BOX) {');
      expect(first.dsl).toContain('on InspectCrate: error(MISSING_ITEM) {');
      expect(first.dsl).toContain('on StoreCrate: timer("PT1H", alongside) {');
      // The `_2` suffix follows print order.
      expect(boundaryEvents(first.ir).map((b) => b.id)).toEqual([
        'BoxTorn',
        'ItemMissing',
        'CrateOverdue',
      ]);
      expect(boundaryEvents(first.reDesugared).map((b) => b.id)).toEqual([
        'Boundary_InspectCrate_error',
        'Boundary_InspectCrate_error_2',
        'Boundary_StoreCrate_timer',
      ]);
      const expected = [
        'InspectCrate error MISSING_ITEM interrupting',
        'InspectCrate error TORN_BOX interrupting',
        'StoreCrate timer duration PT1H alongside',
      ];
      expect(attachmentSignatures(first.ir)).toEqual(expected);
      expect(attachmentSignatures(first.reDesugared)).toEqual(expected);
    });
  },
);
