import { describe, it, expect } from 'vitest';

import { describeNoOverlappingShapes } from './helpers/di-bounds.js';
import {
  definitionRefOf,
  idsOfTag,
  messageRoots,
} from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('task-kinds', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

function openingTag(tag: string, id: string): string {
  const found = new RegExp(`<bpmn:${tag} id="${id}"[^>]*>`).exec(rt.frozenXml);
  expect(
    found,
    `no <bpmn:${tag}> with id '${id}' in the frozen artifact`,
  ).not.toBeNull();
  return found![0];
}

describe('tag choice on the frozen .bpmn', () => {
  it('every statement kind is written under its own tag', () => {
    expect(
      Object.fromEntries(
        ['task', 'sendTask', 'receiveTask', 'businessRuleTask'].map((tag) => [
          tag,
          idsOfTag(rt.frozenXml, tag),
        ]),
      ),
    ).toEqual({
      task: ['RecordOrder'],
      sendTask: ['NotifyWarehouse'],
      receiveTask: ['AwaitSettlement', 'AwaitPickingSlot'],
      businessRuleTask: ['RateRisk', 'ChooseCarrier', 'PriceShipping'],
    });
  });
});

describe('root derivation on the frozen .bpmn', () => {
  it('carries one bpmn:Message per distinct name, and every carrier that names it references that root', () => {
    expect(messageRoots(rt.frozenXml)).toEqual([
      { id: 'Message_PaymentSettled', name: 'PaymentSettled' },
      { id: 'Message_PickingSlotReady', name: 'PickingSlotReady' },
    ]);
    expect(openingTag('receiveTask', 'AwaitSettlement')).toBe(
      '<bpmn:receiveTask id="AwaitSettlement" name="Wait for the payment" messageRef="Message_PaymentSettled">',
    );
    expect(definitionRefOf(rt.frozenXml, 'ForwardSettlement', 'message')).toBe(
      'Message_PaymentSettled',
    );
    expect(openingTag('receiveTask', 'AwaitPickingSlot')).toBe(
      '<bpmn:receiveTask id="AwaitPickingSlot" name="Wait for a picking slot">',
    );
  });
});

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it("the decompiled DSL' writes each kind back on its own statement", () => {
    expect(rt.dslPrime).toBe(
      [
        'process order-settlement {',
        '  start OrderReceived',
        '  step RecordOrder(label: "Record the order")',
        '  send NotifyWarehouse(label: "Tell the warehouse", class: "com.example.orders.NotifyWarehouseDelegate")',
        '  receive AwaitSettlement(label: "Wait for the payment", message: "PaymentSettled")',
        '  receive AwaitPickingSlot(label: "Wait for a picking slot")',
        '  emit message ConfirmPicking("PickingSlotReady", class: "com.example.orders.ConfirmPickingDelegate")',
        '  decide RateRisk(label: "Rate the order risk", decision: "riskRating", binding: latest, mapDecisionResult: singleEntry, resultVariable: "risk")',
        '  decide ChooseCarrier(label: "Choose a carrier", class: "com.example.orders.ChooseCarrierDelegate")',
        '  decide PriceShipping(label: "Price the shipping", decision: "shippingTariff", version: 3)',
        '  throw message ForwardSettlement("PaymentSettled", class: "com.example.orders.PublishSettlementDelegate")',
        '}',
        '',
      ].join('\n'),
    );
  });
});

describeNoOverlappingShapes(rt);
