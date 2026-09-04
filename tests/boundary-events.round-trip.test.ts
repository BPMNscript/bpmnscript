import { describe, it, expect } from 'vitest';

import { Diagnostic } from 'vscode-languageserver-types';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

import {
  boundsOf,
  describeSingleDiagram,
  parseShapeBounds,
} from './helpers/di-bounds.js';
import type { Bounds } from './helpers/di-bounds.js';
import { describeImportFirst } from './helpers/import-first.js';
import { kindOf, subProcess } from './helpers/ir-query.js';
import { definitionRefOf, errorRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('boundary-events', {
  importPath: true,
  recompile: 'errors',
});

// The decompiler prints handlers in a trailing group, so its output must never
// raise this. Source that does cannot be re-opened.
const HANDLER_PLACEMENT_DIAGNOSTIC =
  'Event handlers read like catch blocks: move it after the last step of this body.';

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

// bpmn-auto-layout places `attachedToRef` children on the host's bottom edge,
// spread evenly: `n` attachers land at `x + width * i/(n+1)` for i in 1..n.
// Measuring against the host's own bounds stops a shape elsewhere on the canvas
// satisfying the check.
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

// Handwritten import-first: MIWG `<bpmn:incoming>`/`<bpmn:outgoing>` children
// and hand-named boundary ids matching nothing the id template would produce.
// Two share the host `InspectCrate` and the trigger kind `error`, so
// re-synthesis necessarily collides and hands one of them the `_2` suffix.
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

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it("every handler block in DSL' trails the body it guards", async () => {
    // A boundary handler is walked early, so the orphan sweep does not mistake
    // its escape chain for a detached fragment, yet it must print in the
    // trailing group: printed in place it emits source the validator rejects.
    const { diagnostics } = await rt.validate(rt.dslPrime);
    expect(
      diagnostics.filter(
        (d) => Diagnostic.getMessageString(d) === HANDLER_PLACEMENT_DIAGNOSTIC,
      ),
    ).toEqual([]);
  });

  it('the authored ids survive verbatim at their correct container depth', () => {
    expect(kindOf(rt.ir3, 'CheckAddress')).toBe('userTask');
    expect(kindOf(rt.ir3, 'PackGoods')).toBe('subProcess');
    expect(kindOf(rt.ir3, 'ComputeShipping')).toBe('scriptTask');
    expect(kindOf(rt.ir3, 'ChargePostage')).toBe('serviceTask');
    expect(kindOf(rt.ir3, 'PrintLabel')).toBe('serviceTask');
    expect(kindOf(rt.ir3, 'BookCarrier')).toBe('callActivity');
    expect(kindOf(rt.ir3, 'HandOverParcel')).toBe('userTask');
    // The escalation is emitted one container down, inside the sub-process the
    // escalation boundary is attached to.
    expect(kindOf(subProcess(rt.ir3, 'PackGoods'), 'Oversized')).toBe(
      'intermediateThrowEvent',
    );
  });

  it("each boundary's host, trigger, payload, and cancelActivity survive at every hop", () => {
    for (const [label, ir] of rt.hops) {
      expect(
        attachmentSignatures(ir),
        `attachments differ in ${label}`,
      ).toEqual(EXPECTED_ATTACHMENTS);
    }
  });

  it('the escape chain that rejoins the main flow keeps a real edge into its target', () => {
    // The handler body and the main flow share one container, which is what
    // makes `goto PackGoods` expressible as a real sequence flow.
    const rejoin = rt.ir3.sequenceFlows.find(
      (sf) => sf.sourceRef === 'MarkAddressVerified',
    );
    expect(rejoin?.targetRef).toBe('PackGoods');
  });

  it('the if inside an escape chain comes back as an if, not as gotos', () => {
    // The boundary event is wired to the CFG's virtual entry, so its escape
    // chain is reachable and the split inside it has an immediate dominator;
    // without that the restructurer could only degrade the branch into jumps.
    expect(rt.dslPrime).toContain('if (parcelValue > 500) {');
  });
});

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('each task host carries its boundary event, pinned by attachedToRef', () => {
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ComputeShipping_timer" cancelActivity="false" attachedToRef="ComputeShipping">',
    );
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargePostage_error" attachedToRef="ChargePostage">',
    );
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_PrintLabel_message" attachedToRef="PrintLabel">',
    );
  });
});

describeSingleDiagram(rt);

describe('DI attachment on the generated .bpmn', () => {
  it('every boundary shape sits centered and half-overlapping on its host edge', () => {
    const bounds = parseShapeBounds(rt.generatedXml);

    assertAttachedToHost(bounds, 'CheckAddress', [
      'Boundary_CheckAddress_message',
      'Boundary_CheckAddress_timer',
    ]);
    assertAttachedToHost(bounds, 'PackGoods', [
      'Boundary_PackGoods_error',
      'Boundary_PackGoods_escalation',
    ]);
    assertAttachedToHost(bounds, 'BookCarrier', [
      'Boundary_BookCarrier_signal',
    ]);
    assertAttachedToHost(bounds, 'HandOverParcel', [
      'Boundary_HandOverParcel_condition',
    ]);
    assertAttachedToHost(bounds, 'ComputeShipping', [
      'Boundary_ComputeShipping_timer',
    ]);
    assertAttachedToHost(bounds, 'ChargePostage', [
      'Boundary_ChargePostage_error',
    ]);
    assertAttachedToHost(bounds, 'PrintLabel', ['Boundary_PrintLabel_message']);
  });

  it('the sub-process host carries its boundaries on the expanded box, not a task-sized one', () => {
    // The host's bounds are computed from its children, so its lower edge only
    // exists once the sub-process body has been laid out.
    const bounds = parseShapeBounds(rt.generatedXml);
    const host = boundsOf(bounds, 'PackGoods');
    const child = boundsOf(bounds, 'PickItems');

    expect(host.width).toBeGreaterThan(child.width);
    expect(host.height).toBeGreaterThan(child.height);
    expect(rt.generatedXml).toContain(
      'bpmnElement="PackGoods" isExpanded="true"',
    );
    for (const id of [
      'Boundary_PackGoods_error',
      'Boundary_PackGoods_escalation',
    ]) {
      expect(boundsOf(bounds, id).y + 18).toBeCloseTo(host.y + host.height, 3);
    }
  });
});

describe('root sharing on the frozen .bpmn', () => {
  it('the boundary signal and the host-less handler signal share one bpmn:Signal', () => {
    const roots = [...rt.frozenXml.matchAll(/<bpmn:signal id="([^"]+)"/g)];
    expect(roots).toHaveLength(1);
    const rootId = roots[0]![1];

    expect(
      definitionRefOf(rt.frozenXml, 'Boundary_BookCarrier_signal', 'signal'),
    ).toBe(rootId);
    expect(definitionRefOf(rt.frozenXml, 'StrikeNoted', 'signal')).toBe(rootId);
  });

  it('the escalation thrown inside the sub-process and the one caught on its boundary share one bpmn:Escalation', () => {
    const roots = [...rt.frozenXml.matchAll(/<bpmn:escalation id="([^"]+)"/g)];
    expect(roots).toHaveLength(1);
    const rootId = roots[0]![1];

    expect(definitionRefOf(rt.frozenXml, 'Oversized', 'escalation')).toBe(
      rootId,
    );
    expect(
      definitionRefOf(
        rt.frozenXml,
        'Boundary_PackGoods_escalation',
        'escalation',
      ),
    ).toBe(rootId);
  });

  it('the error a boundary catches gets a root carrying its declared message', () => {
    const roots = errorRoots(rt.frozenXml, 'PAYMENT_DECLINED');
    expect(roots).toHaveLength(1);
    const { id: rootId, message } = roots[0]!;
    expect(message).toBe('The payment gateway declined the charge');

    expect(
      definitionRefOf(rt.frozenXml, 'Boundary_ChargePostage_error', 'error'),
    ).toBe(rootId);
  });

  it('the message a boundary correlates on gets its own bpmn:Message root', () => {
    const roots = [
      ...rt.frozenXml.matchAll(
        /<bpmn:message id="([^"]+)" name="ExpediteRequested"/g,
      ),
    ];
    expect(roots).toHaveLength(1);

    expect(
      definitionRefOf(rt.frozenXml, 'Boundary_PrintLabel_message', 'message'),
    ).toBe(roots[0]![1]);
  });
});

describeImportFirst(
  'a handwritten .bpmn with hand-named boundary ids round-trips',
  IMPORT_FIRST_BPMN,
  (first) => {
    it('prints each boundary as an attached handler naming its host', () => {
      expect(first.dsl).toContain('on InspectCrate: error "TORN_BOX" {');
      expect(first.dsl).toContain('on InspectCrate: error "MISSING_ITEM" {');
      expect(first.dsl).toContain(
        'on StoreCrate: timer after "PT1H" alongside {',
      );
    });

    it('re-synthesizes the host-derived ids, suffixing the second of the colliding pair', () => {
      // Which of the two colliding boundaries owns the `_2` suffix follows from
      // print order, not from anything either boundary carries.
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
    });

    it('keeps every host, trigger payload, and cancelActivity paired correctly', () => {
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
