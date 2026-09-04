import { describe, it, expect } from 'vitest';

import {
  boundsOf,
  describeDiContainment,
  describeNoOverlappingShapes,
  parseShapeBounds,
} from './helpers/di-bounds.js';
import { endEvent, subProcess, theOnly } from './helpers/ir-query.js';
import { idsOfTag } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('transactions', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// Neither block nests another of its own tag, so a lazy match to the first
// closing tag reads exactly one block.
function blockOf(xml: string, tag: string, id: string): string {
  const found = new RegExp(
    `<bpmn:${tag} id="${id}"[\\s\\S]*?</bpmn:${tag}>`,
  ).exec(xml);
  expect(
    found,
    `no <bpmn:${tag}> '${id}' in the frozen artifact`,
  ).not.toBeNull();
  return found![0];
}

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('both blocks that can be given up keep their element at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(
        subProcess(ir, 'BookAndPay').element,
        `BookAndPay differs in ${label}`,
      ).toBe('transaction');
      expect(
        subProcess(subProcess(ir, 'PrepareDeparture'), 'AssignSeatRows')
          .element,
        `AssignSeatRows differs in ${label}`,
      ).toBe('transaction');
    }
  });

  it('the ordinary blocks carry no element at any hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(
        subProcess(ir, 'PrepareDeparture').element,
        `PrepareDeparture differs in ${label}`,
      ).toBeUndefined();
      expect(
        subProcess(subProcess(ir, 'BookAndPay'), 'HoldSeats').element,
        `HoldSeats differs in ${label}`,
      ).toBeUndefined();
    }
  });

  it('the cancel end keeps its trigger and its label at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const abandoned = endEvent(ir, 'BookingAbandoned');
      expect(abandoned.eventDefinition, `trigger differs in ${label}`).toEqual({
        kind: 'cancel',
      });
      expect(abandoned.name, `label differs in ${label}`).toBe(
        'Give up the booking',
      );
    }
  });

  it('the cancel handler stays attached to the block it gives up at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const boundary = theOnly(
        ir,
        'boundaryEvent',
        (el) => el.eventDefinition.kind === 'cancel',
      );
      expect(boundary.attachedToRef, `host differs in ${label}`).toBe(
        'BookAndPay',
      );
      expect(
        boundary.cancelActivity,
        `interruption differs in ${label}`,
      ).toBeUndefined();
    }
  });

  it('the repeated block keeps its clause and its setting at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const repeated = subProcess(
        subProcess(ir, 'PrepareDeparture'),
        'AssignSeatRows',
      );
      expect(repeated.loop, `repeat clause differs in ${label}`).toEqual({
        collection: 'seatRows',
        elementVariable: 'row',
        sequential: true,
      });
      expect(repeated.asyncBefore, `asyncBefore differs in ${label}`).toBe(
        true,
      );
    }
  });

  it("the decompiled DSL' writes every head and trigger back in the surface spelling", () => {
    expect(rt.dslPrime).toContain(
      'attempt BookAndPay "Try to book and pay for the seats" {',
    );
    expect(rt.dslPrime).toContain(
      'attempt AssignSeatRows "Spread the party across rows" for each row in seatRows sequentially { asyncBefore = true } {',
    );
    expect(rt.dslPrime).toContain('subprocess HoldSeats "Hold the seats" {');
    expect(rt.dslPrime).toContain(
      'end BookingAbandoned "Give up the booking" cancel',
    );
    expect(rt.dslPrime).toContain('on BookAndPay: cancel {');
    expect(rt.dslPrime).toContain(
      'on BookAndPay: error "PAYMENT_UNAVAILABLE" (code c, message m) {',
    );
  });
});

describe('block shape pins on the frozen .bpmn', () => {
  it('freezes the two heads as two tags, side by side', () => {
    expect(idsOfTag(rt.frozenXml, 'transaction')).toEqual([
      'BookAndPay',
      'AssignSeatRows',
    ]);
    expect(idsOfTag(rt.frozenXml, 'subProcess')).toEqual(
      expect.arrayContaining(['HoldSeats', 'PrepareDeparture']),
    );
  });

  it('the cancel end sits inside the block it gives up and carries a bare definition', () => {
    expect(rt.frozenXml.match(/<bpmn:cancelEventDefinition\b[^>]*>/g)).toEqual([
      '<bpmn:cancelEventDefinition />',
      '<bpmn:cancelEventDefinition />',
    ]);

    const block = blockOf(rt.frozenXml, 'transaction', 'BookAndPay');
    const end = blockOf(block, 'endEvent', 'BookingAbandoned');
    expect(end).toContain('<bpmn:cancelEventDefinition />');
    expect(block.match(/<bpmn:cancelEventDefinition\b/g)).toHaveLength(1);
  });

  it('the cancel handler is a boundary event attached to that same block', () => {
    const boundary = blockOf(
      rt.frozenXml,
      'boundaryEvent',
      'Boundary_BookAndPay_cancel',
    );
    expect(boundary).toContain('attachedToRef="BookAndPay"');
    expect(boundary).toContain('<bpmn:cancelEventDefinition />');
    expect(boundary).not.toContain('cancelActivity');
  });

  it('the error handler still attaches to the block beside the cancel one', () => {
    const boundary = blockOf(
      rt.frozenXml,
      'boundaryEvent',
      'Boundary_BookAndPay_error',
    );
    expect(boundary).toContain('attachedToRef="BookAndPay"');
    expect(boundary).toContain('errorRef="Error_PAYMENT_UNAVAILABLE"');
  });

  it('the undo block inside the block is a triggeredByEvent block on a compensate start', () => {
    const handler = subProcess(
      subProcess(rt.ir1, 'BookAndPay'),
      'HoldSeats',
    ).flowElements.find(
      (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
    );
    expect(handler?.kind).toBe('subProcess');

    const undo = blockOf(rt.frozenXml, 'subProcess', handler!.id);
    expect(undo).toContain('triggeredByEvent="true"');
    expect(undo).toContain('<bpmn:compensateEventDefinition />');
  });

  it('the repeated block writes its repetition and its setting on the transaction tag', () => {
    const block = blockOf(rt.frozenXml, 'transaction', 'AssignSeatRows');
    expect(block).toContain('operaton:asyncBefore="true"');
    expect(block).toContain(
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="seatRows" operaton:elementVariable="row" />',
    );
  });
});

describeNoOverlappingShapes(rt);

describe('boundary placement on the frozen .bpmn', () => {
  it('both attachers sit centered on the lower edge of the block they watch', () => {
    const bounds = parseShapeBounds(rt.frozenXml);
    const host = boundsOf(bounds, 'BookAndPay');

    for (const id of [
      'Boundary_BookAndPay_cancel',
      'Boundary_BookAndPay_error',
    ]) {
      const attacher = boundsOf(bounds, id);
      expect(
        attacher.y + attacher.height / 2,
        `${id} is not centered on the lower edge of BookAndPay`,
      ).toBeCloseTo(host.y + host.height, 3);
    }
  });
});

describeDiContainment(rt, [
  'BookAndPay',
  'HoldSeats',
  'PrepareDeparture',
  'AssignSeatRows',
]);
