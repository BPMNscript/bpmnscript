/**
 * Frozen golden and round-trip proof for the intermediate catch event
 * (`await <trigger>`), the blocking in-flow wait that pauses the token until a
 * message, timer, signal, or condition fires, then falls through to the next
 * step on the main sequence flow.
 *
 * The fixture puts all four catchable triggers back to back on one main flow, so
 * the frozen `.bpmn` covers every payload shape (message name, timer duration,
 * signal name, and a rendered boolean expression) in a single artifact.
 */

import { describe, it, expect } from 'vitest';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('intermediate-catch', {
  dslPrimeFrom: 'frozen',
  recompile: 'errors-standalone',
});

type IntermediateCatchEvent = Extract<
  FlowElement,
  { kind: 'intermediateCatchEvent' }
>;

function catchEvents(container: FlowContainer): IntermediateCatchEvent[] {
  return container.flowElements.filter(
    (fe): fe is IntermediateCatchEvent => fe.kind === 'intermediateCatchEvent',
  );
}

/**
 * A catch rendered as its trigger and payload, everything about it that is not
 * its id: the surface carries no name slot and the id is always synthesized.
 */
function triggerSignature(catchEvent: IntermediateCatchEvent): string {
  const def = catchEvent.eventDefinition;
  switch (def.kind) {
    case 'message':
      return `message ${def.messageName}`;
    case 'signal':
      return `signal ${def.signalName}`;
    case 'timer':
      return `timer ${def.timerKind} ${def.expression}`;
    case 'conditional':
      return `condition ${def.condition}`;
  }
}

function triggerSignatures(container: FlowContainer): string[] {
  return catchEvents(container).map(triggerSignature);
}

/**
 * The four triggers the fixture awaits, in flow order. Frozen here so a hop that
 * drops a catch, reorders it, or loses its payload fails with a readable diff
 * rather than a deep-equality dump.
 */
const EXPECTED_TRIGGERS = [
  'message PaymentConfirmed',
  'timer duration PT1H',
  'signal StockReplenished',
  'condition ${amount > 100}',
];

describe('idempotence: golden .bpmn → IR₂ → DSL′ → IR₃', () => {
  it('every catch keeps its trigger and payload, in order, at every hop', () => {
    for (const [label, ir] of [
      ['IR₁', rt.ir1],
      ['IR₂', rt.ir2],
      ['IR₃', rt.ir3],
    ] as const) {
      expect(triggerSignatures(ir), `triggers differ in ${label}`).toEqual(
        EXPECTED_TRIGGERS,
      );
    }
  });

  it('no synthesized Catch_ id token leaks into the decompiled source', () => {
    // `await` has no authored name slot, so the decompiler prints the trigger
    // and its payload and never the synthesized goto-target id.
    expect(rt.dslPrime).not.toMatch(/Catch_/);
  });
});
