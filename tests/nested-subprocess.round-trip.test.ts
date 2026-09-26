import { describe, it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import { describeDiContainment } from './helpers/di-bounds.js';
import { idsOf } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('nested-subprocess', {
  importPath: true,
  recompile: 'errors',
  validatorCleanTitles: [
    'the fixture opens validator-clean',
    'produces no diagnostics at all',
  ],
});

// `<kind> <id>` per container, at any depth, in element order.
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

// No sequence flow may reference an element outside its own container. That
// invariant is what lets a parent treat a sub-process as one opaque activity.
function assertNoBoundaryCrossingFlows(container: FlowContainer): void {
  const own = idsOf(container);
  for (const flow of container.sequenceFlows) {
    expect(
      own.has(flow.sourceRef),
      `flow ${flow.id} source ${flow.sourceRef} escapes container ${container.id}`,
    ).toBe(true);
    expect(
      own.has(flow.targetRef),
      `flow ${flow.id} target ${flow.targetRef} escapes container ${container.id}`,
    ).toBe(true);
  }
  for (const fe of container.flowElements) {
    if (fe.kind === 'subProcess') assertNoBoundaryCrossingFlows(fe);
  }
}

describe("idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3", () => {
  it("the restructured DSL' reconstructs every sub-process as a `subprocess` block around its own steps", () => {
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
  });

  it('every container holds exactly its own elements, at every depth and every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(containment(ir), `containment differs in ${label}`).toEqual(
        CONTAINMENT,
      );
    }
  });

  it('the parent chain threads start -> RecordOrder -> Payment -> Fulfillment -> CloseOrder -> end at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(
        ir.sequenceFlows.map((f) => `${f.sourceRef}->${f.targetRef}`),
        `top-level flows differ in ${label}`,
      ).toEqual([
        'OrderReceived->RecordOrder',
        'RecordOrder->Payment',
        'Payment->Fulfillment',
        'Fulfillment->CloseOrder',
        'CloseOrder->OrderClosed',
      ]);
    }
  });

  it('no sequence flow crosses a container boundary, at any depth or hop', () => {
    for (const [, ir] of rt.hops) assertNoBoundaryCrossingFlows(ir);
  });
});

describeDiContainment(rt, ['Payment', 'Fulfillment', 'Shipping', 'PackParcel']);
