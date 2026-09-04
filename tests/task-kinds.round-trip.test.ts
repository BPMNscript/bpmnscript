import { describe, it, expect } from 'vitest';

import { describeNoOverlappingShapes } from './helpers/di-bounds.js';
import { definitionRefOf, messageRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('task-kinds', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

function countOf(tag: string): number {
  return rt.frozenXml.split(`<bpmn:${tag} `).length - 1;
}

function openingTag(tag: string, id: string): string {
  const found = new RegExp(`<bpmn:${tag} id="${id}"[^>]*>`).exec(rt.frozenXml);
  expect(
    found,
    `no <bpmn:${tag}> with id '${id}' in the frozen artifact`,
  ).not.toBeNull();
  return found![0];
}

describe('tag choice on the frozen .bpmn', () => {
  it.each<[tag: string, count: number]>([
    ['task', 1],
    ['sendTask', 1],
    ['receiveTask', 2],
    ['businessRuleTask', 3],
  ])('bpmn:%s appears %i time(s)', (tag, count) => {
    expect(countOf(tag)).toBe(count);
  });
});

describe('root derivation on the frozen .bpmn', () => {
  it('carries one bpmn:Message per distinct name, in first-appearance order', () => {
    expect(messageRoots(rt.frozenXml).map((root) => root.name)).toEqual([
      'PaymentSettled',
      'PickingSlotReady',
    ]);
  });

  it('the receive task and the message end share the root their name derives', () => {
    const root = messageRoots(rt.frozenXml)[0]!.id;
    expect(openingTag('receiveTask', 'AwaitSettlement')).toContain(
      `messageRef="${root}"`,
    );
    expect(definitionRefOf(rt.frozenXml, 'ForwardSettlement', 'message')).toBe(
      root,
    );
  });

  it('the receive task naming no message carries no messageRef', () => {
    expect(openingTag('receiveTask', 'AwaitPickingSlot')).not.toContain(
      'messageRef',
    );
  });
});

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it("the decompiled DSL' writes each kind back on its own statement", () => {
    expect(rt.dslPrime).toContain('step RecordOrder "Record the order"');
    expect(rt.dslPrime).toContain(
      'send NotifyWarehouse "Tell the warehouse" ' +
        '{ class = "com.example.orders.NotifyWarehouseDelegate" }',
    );
    expect(rt.dslPrime).toContain(
      'receive AwaitSettlement "Wait for the payment" { message = "PaymentSettled" }',
    );
    expect(rt.dslPrime).toContain(
      'receive AwaitPickingSlot "Wait for a picking slot"',
    );
    expect(rt.dslPrime).toContain(
      'decide RateRisk "Rate the order risk" { decision = "riskRating" ' +
        'binding = latest mapDecisionResult = singleEntry resultVariable = "risk" }',
    );
    expect(rt.dslPrime).toContain(
      'decide ChooseCarrier "Choose a carrier" ' +
        '{ class = "com.example.orders.ChooseCarrierDelegate" }',
    );
    expect(rt.dslPrime).toContain(
      'decide PriceShipping "Price the shipping" ' +
        '{ decision = "shippingTariff" version = 3 }',
    );
    expect(rt.dslPrime).toContain(
      'throw message ForwardSettlement "PaymentSettled" ' +
        '{ class = "com.example.orders.PublishSettlementDelegate" }',
    );
  });
});

describeNoOverlappingShapes(rt);
