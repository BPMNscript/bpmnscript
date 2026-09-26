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
import type { BpmnProcess } from '@bpmn-script/transform';

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
  it.each([
    [
      'the outer block that can be given up keeps its element',
      (ir: BpmnProcess) => subProcess(ir, 'BookAndPay').element,
      'transaction',
    ],
    [
      'the nested block that can be given up keeps its element',
      (ir: BpmnProcess) =>
        subProcess(subProcess(ir, 'PrepareDeparture'), 'AssignSeatRows')
          .element,
      'transaction',
    ],
    [
      'the ordinary outer block carries no element',
      (ir: BpmnProcess) => subProcess(ir, 'PrepareDeparture').element,
      undefined,
    ],
    [
      'the ordinary nested block carries no element',
      (ir: BpmnProcess) =>
        subProcess(subProcess(ir, 'BookAndPay'), 'HoldSeats').element,
      undefined,
    ],
    [
      'the cancel end keeps its trigger and its label',
      (ir: BpmnProcess) => {
        const { eventDefinition, name } = endEvent(ir, 'BookingAbandoned');
        return { eventDefinition, name };
      },
      { eventDefinition: { kind: 'cancel' }, name: 'Give up the booking' },
    ],
    [
      'the cancel handler stays attached, interrupting, to the block it gives up',
      (ir: BpmnProcess) => {
        const { attachedToRef, cancelActivity } = theOnly(
          ir,
          'boundaryEvent',
          (el) => el.eventDefinition.kind === 'cancel',
        );
        return { attachedToRef, cancelActivity };
      },
      { attachedToRef: 'BookAndPay', cancelActivity: undefined },
    ],
    [
      'the repeated block keeps its clause and its setting',
      (ir: BpmnProcess) => {
        const { loop, asyncBefore } = subProcess(
          subProcess(ir, 'PrepareDeparture'),
          'AssignSeatRows',
        );
        return { loop, asyncBefore };
      },
      {
        loop: {
          collection: 'seatRows',
          elementVariable: 'row',
          sequential: true,
        },
        asyncBefore: true,
      },
    ],
  ] as const)('%s at every hop', (_title, pick, expected) => {
    for (const [label, ir] of rt.hops) {
      expect(pick(ir), `differs in ${label}`).toEqual(expected);
    }
  });

  it("the decompiled DSL' writes every head and trigger back in the surface spelling", () => {
    expect(rt.dslPrime).toContain(
      'attempt BookAndPay(label: "Try to book and pay for the seats") {',
    );
    expect(rt.dslPrime).toContain(
      'attempt AssignSeatRows for each row in seatRows sequentially(' +
        'label: "Spread the party across rows", asyncBefore: true) {',
    );
    expect(rt.dslPrime).toContain(
      'subprocess HoldSeats(label: "Hold the seats") {',
    );
    expect(rt.dslPrime).toContain(
      'end BookingAbandoned cancel(label: "Give up the booking")',
    );
    expect(rt.dslPrime).toContain('on BookAndPay: cancel {');
    expect(rt.dslPrime).toContain(
      'on BookAndPay: error(PAYMENT_UNAVAILABLE, code: c, message: m) {',
    );
  });
});

describe('block shape pins on the frozen .bpmn', () => {
  it('freezes the two heads as two tags, side by side', () => {
    expect(idsOfTag(rt.frozenXml, 'transaction')).toEqual([
      'BookAndPay',
      'AssignSeatRows',
    ]);
    expect(idsOfTag(rt.frozenXml, 'subProcess')).toEqual([
      'HoldSeats',
      'EventSubProcess_seat-booking_2_1_3',
      'PrepareDeparture',
    ]);
  });

  it('the cancel end sits inside the block it gives up and carries a bare definition', () => {
    expect(rt.frozenXml.match(/<bpmn:cancelEventDefinition\b[^>]*>/g)).toEqual([
      '<bpmn:cancelEventDefinition />',
      '<bpmn:cancelEventDefinition />',
    ]);

    const block = blockOf(rt.frozenXml, 'transaction', 'BookAndPay');
    expect(blockOf(block, 'endEvent', 'BookingAbandoned')).toBe(
      '<bpmn:endEvent id="BookingAbandoned" name="Give up the booking">\n' +
        '        <bpmn:incoming>Flow_Gateway_seat-booking_2_3_split_BookingAbandoned</bpmn:incoming>\n' +
        '        <bpmn:cancelEventDefinition />\n' +
        '      </bpmn:endEvent>',
    );
    expect(block.match(/<bpmn:cancelEventDefinition\b/g)).toHaveLength(1);
  });

  it('the cancel and error handlers are both boundary events attached to that same block', () => {
    expect(
      blockOf(rt.frozenXml, 'boundaryEvent', 'Boundary_BookAndPay_cancel'),
    ).toBe(
      '<bpmn:boundaryEvent id="Boundary_BookAndPay_cancel" attachedToRef="BookAndPay">\n' +
        '      <bpmn:outgoing>Flow_Boundary_BookAndPay_cancel_ApologizeToTraveler</bpmn:outgoing>\n' +
        '      <bpmn:cancelEventDefinition />\n' +
        '    </bpmn:boundaryEvent>',
    );
    expect(
      blockOf(rt.frozenXml, 'boundaryEvent', 'Boundary_BookAndPay_error'),
    ).toBe(
      '<bpmn:boundaryEvent id="Boundary_BookAndPay_error" attachedToRef="BookAndPay">\n' +
        '      <bpmn:outgoing>Flow_Boundary_BookAndPay_error_RecordProviderOutage</bpmn:outgoing>\n' +
        '      <bpmn:errorEventDefinition errorRef="Error_PAYMENT_UNAVAILABLE" operaton:errorCodeVariable="c" operaton:errorMessageVariable="m" />\n' +
        '    </bpmn:boundaryEvent>',
    );
  });

  it('the undo block inside the block is a triggeredByEvent block on a compensate start', () => {
    const undo = blockOf(
      rt.frozenXml,
      'subProcess',
      'EventSubProcess_seat-booking_2_1_3',
    );
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
