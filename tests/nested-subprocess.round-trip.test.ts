import { describe, it, expect } from 'vitest';

import type { FlowContainer } from '@bpmn-script/transform';

import { describeDiContainment } from './helpers/di-bounds.js';
import { kindOf, idsOf, subProcess } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('nested-subprocess', {
  importPath: true,
  recompile: 'errors',
  validatorCleanTitles: [
    'the fixture opens validator-clean',
    'produces no diagnostics at all',
  ],
});

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
  it("the restructured DSL' reconstructs both sub-processes as `subprocess` blocks", () => {
    expect(rt.dslPrime).toContain('subprocess Payment "Handle payment" {');
    expect(rt.dslPrime).toContain(
      'subprocess Fulfillment "Fulfill the order" {',
    );
    expect(rt.dslPrime).toContain('subprocess Shipping "Ship the parcel" {');
    expect(rt.dslPrime).toContain('if (amount > 1000)');
    expect(rt.dslPrime).toContain('while (retries < 3)');
  });

  it('authored ids survive verbatim at their correct container depth', () => {
    expect(kindOf(rt.ir3, 'OrderReceived')).toBe('startEvent');
    expect(kindOf(rt.ir3, 'RecordOrder')).toBe('userTask');
    expect(kindOf(rt.ir3, 'Payment')).toBe('subProcess');
    expect(kindOf(rt.ir3, 'Fulfillment')).toBe('subProcess');
    expect(kindOf(rt.ir3, 'CloseOrder')).toBe('userTask');
    expect(kindOf(rt.ir3, 'OrderClosed')).toBe('endEvent');

    const payment = subProcess(rt.ir3, 'Payment');
    expect(kindOf(payment, 'ManualReview')).toBe('userTask');
    expect(kindOf(payment, 'AutoCharge')).toBe('serviceTask');
    expect(idsOf(rt.ir3).has('ManualReview')).toBe(false);

    const fulfillment = subProcess(rt.ir3, 'Fulfillment');
    expect(kindOf(fulfillment, 'FulfillmentStart')).toBe('startEvent');
    expect(kindOf(fulfillment, 'FulfillmentDone')).toBe('endEvent');
    expect(kindOf(fulfillment, 'ReserveStock')).toBe('serviceTask');
    expect(kindOf(fulfillment, 'Shipping')).toBe('subProcess');

    const shipping = subProcess(fulfillment, 'Shipping');
    expect(kindOf(shipping, 'PackParcel')).toBe('userTask');
    expect(kindOf(shipping, 'DispatchParcel')).toBe('serviceTask');
    expect(idsOf(fulfillment).has('PackParcel')).toBe(false);
  });
});

// The nested shapes are named so the walk cannot pass on an empty tree.
describeDiContainment(rt, ['Payment', 'Fulfillment', 'Shipping', 'PackParcel']);

describe('structure: IR1 pins the containment shape', () => {
  it('the parent chain threads start -> RecordOrder -> Payment -> Fulfillment -> CloseOrder -> end', () => {
    const edge = (source: string) =>
      rt.ir1.sequenceFlows.find((f) => f.sourceRef === source)?.targetRef;
    expect(edge('OrderReceived')).toBe('RecordOrder');
    expect(edge('RecordOrder')).toBe('Payment');
    expect(edge('Payment')).toBe('Fulfillment');
    expect(edge('Fulfillment')).toBe('CloseOrder');
    expect(edge('CloseOrder')).toBe('OrderClosed');
  });

  it('nested elements do not leak into the parent container', () => {
    const top = idsOf(rt.ir1);
    for (const nested of [
      'ManualReview',
      'AutoCharge',
      'ReserveStock',
      'PackParcel',
      'DispatchParcel',
      'FulfillmentStart',
      'FulfillmentDone',
    ]) {
      expect(top.has(nested)).toBe(false);
    }
  });

  it('each sub-process holds its own body elements', () => {
    const payment = subProcess(rt.ir1, 'Payment');
    expect(idsOf(payment)).toContain('ManualReview');
    expect(idsOf(payment)).toContain('AutoCharge');

    const fulfillment = subProcess(rt.ir1, 'Fulfillment');
    expect(idsOf(fulfillment)).toContain('ReserveStock');
    expect(idsOf(fulfillment)).toContain('Shipping');

    const shipping = subProcess(fulfillment, 'Shipping');
    expect(idsOf(shipping)).toContain('PackParcel');
    expect(idsOf(shipping)).toContain('DispatchParcel');
  });

  it('no sequence flow crosses a container boundary, at any depth', () => {
    assertNoBoundaryCrossingFlows(rt.ir1);
  });
});
