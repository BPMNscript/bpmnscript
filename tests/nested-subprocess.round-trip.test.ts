import { it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import { idsOf } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('nested-subprocess', {
  importPath: true,
  recompile: 'errors',
});

function containment(container: FlowContainer): Record<string, string[]> {
  return Object.assign(
    {
      [container.id]: container.flowElements.map((fe) => `${fe.kind} ${fe.id}`),
    },
    ...container.flowElements
      .filter((fe) => fe.kind === 'subProcess')
      .map(containment),
  );
}

const CONTAINMENT: Record<string, string[]> = {
  'order-fulfillment': [
    'startEvent OrderReceived',
    'userTask RecordOrder',
    'subProcess Payment',
    'subProcess Fulfillment',
    'userTask CloseOrder',
    'endEvent OrderClosed',
  ],
  Payment: [
    'startEvent StartEvent_Payment',
    'exclusiveGateway Gateway_order-fulfillment_2_0_split',
    'exclusiveGateway Gateway_order-fulfillment_2_0_join',
    'userTask ManualReview',
    'serviceTask AutoCharge',
    'endEvent EndEvent_Payment',
  ],
  Fulfillment: [
    'startEvent FulfillmentStart',
    'exclusiveGateway Gateway_order-fulfillment_3_1_loop',
    'serviceTask ReserveStock',
    'subProcess Shipping',
    'endEvent FulfillmentDone',
  ],
  Shipping: [
    'startEvent StartEvent_Shipping',
    'userTask PackParcel',
    'serviceTask DispatchParcel',
    'endEvent EndEvent_Shipping',
  ],
};

// A parent treats a sub-process as one opaque activity only while no flow
// leaves its container.
function assertNoBoundaryCrossingFlows(container: FlowContainer): void {
  const own = idsOf(container);
  for (const flow of container.sequenceFlows) {
    expect(
      [own.has(flow.sourceRef), own.has(flow.targetRef)],
      `flow ${flow.id} escapes ${container.id}`,
    ).toEqual([true, true]);
  }
  for (const fe of container.flowElements) {
    if (fe.kind === 'subProcess') assertNoBoundaryCrossingFlows(fe);
  }
}

it('keeps every container to exactly its own elements and flows at every hop, printing each as a subprocess block', () => {
  expect(rt.dslPrime).toBe(
    [
      'process order-fulfillment {',
      '  var amount: any',
      '  var retries: any',
      '  start OrderReceived',
      '  user RecordOrder(label: "Record order", assignee: "demo")',
      '  subprocess Payment(label: "Handle payment") {',
      '    if (amount > 1000) {',
      '      user ManualReview(label: "Manual review", assignee: "manager")',
      '    } else {',
      '      service AutoCharge(label: "Auto-charge card", class: "com.example.demo.LogDelegate")',
      '    }',
      '  }',
      '  subprocess Fulfillment(label: "Fulfill the order") {',
      '    start FulfillmentStart',
      '    while (retries < 3) {',
      '      service ReserveStock(label: "Reserve stock", class: "com.example.demo.LogDelegate")',
      '    }',
      '    subprocess Shipping(label: "Ship the parcel") {',
      '      user PackParcel(label: "Pack parcel", assignee: "demo")',
      '      service DispatchParcel(label: "Dispatch parcel", class: "com.example.demo.LogDelegate")',
      '    }',
      '    end FulfillmentDone',
      '  }',
      '  user CloseOrder(label: "Close order", assignee: "demo")',
      '  end OrderClosed',
      '}',
      '',
    ].join('\n'),
  );
  for (const [label, ir] of rt.hops) {
    expect(containment(ir), label).toEqual(CONTAINMENT);
    assertNoBoundaryCrossingFlows(ir);
    expect(
      ir.sequenceFlows.map((f) => `${f.sourceRef}->${f.targetRef}`),
      label,
    ).toEqual([
      'OrderReceived->RecordOrder',
      'RecordOrder->Payment',
      'Payment->Fulfillment',
      'Fulfillment->CloseOrder',
      'CloseOrder->OrderClosed',
    ]);
  }
});
