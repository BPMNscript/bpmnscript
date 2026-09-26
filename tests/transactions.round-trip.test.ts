import { it, expect } from 'vitest';

import { boundsOf, parseShapeBounds } from './helpers/di-bounds.js';
import { endEvent, subProcess, theOnly } from './helpers/ir-query.js';
import { idsOfTag } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';
import type { BpmnProcess } from '@bpmn-script/transform';

const rt = roundTripFixture('transactions', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

// No block nests another of its own tag, so the lazy match reads exactly one.
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

it('keeps both kinds of block, the cancel pair and the repetition at every hop, written back in the surface spelling', () => {
  const picks = [
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
  ] as const;
  for (const [label, ir] of rt.hops) {
    for (const [title, pick, expected] of picks) {
      expect(pick(ir), `${title} in ${label}`).toEqual(expected);
    }
  }
  for (const line of [
    'attempt BookAndPay(label: "Try to book and pay for the seats") {',
    'attempt AssignSeatRows for each row in seatRows sequentially(' +
      'label: "Spread the party across rows", asyncBefore: true) {',
    'subprocess HoldSeats(label: "Hold the seats") {',
    'end BookingAbandoned cancel(label: "Give up the booking")',
    'on BookAndPay: cancel {',
    'on BookAndPay: error(PAYMENT_UNAVAILABLE, code: c, message: m) {',
  ]) {
    expect(rt.dslPrime).toContain(line);
  }
});

it('writes the two heads as two tags, the cancel end inside its block, both handlers as boundaries centered on it, the undo block and the repetition', () => {
  expect(idsOfTag(rt.frozenXml, 'transaction')).toEqual([
    'BookAndPay',
    'AssignSeatRows',
  ]);
  expect(idsOfTag(rt.frozenXml, 'subProcess')).toEqual([
    'HoldSeats',
    'EventSubProcess_seat-booking_2_1_3',
    'PrepareDeparture',
  ]);
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
  const undo = blockOf(
    rt.frozenXml,
    'subProcess',
    'EventSubProcess_seat-booking_2_1_3',
  );
  expect(undo).toContain('triggeredByEvent="true"');
  expect(undo).toContain('<bpmn:compensateEventDefinition />');
  const repeated = blockOf(rt.frozenXml, 'transaction', 'AssignSeatRows');
  expect(repeated).toContain('operaton:asyncBefore="true"');
  expect(repeated).toContain(
    '<bpmn:multiInstanceLoopCharacteristics isSequential="true" operaton:collection="seatRows" operaton:elementVariable="row" />',
  );
  const bounds = parseShapeBounds(rt.frozenXml);
  const host = boundsOf(bounds, 'BookAndPay');
  for (const id of [
    'Boundary_BookAndPay_cancel',
    'Boundary_BookAndPay_error',
  ]) {
    const attacher = boundsOf(bounds, id);
    expect(attacher.y + attacher.height / 2, id).toBeCloseTo(
      host.y + host.height,
      3,
    );
  }
});
