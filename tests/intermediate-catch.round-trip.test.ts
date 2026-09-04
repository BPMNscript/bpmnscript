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

// Trigger and payload only: the surface has no name slot and the id is always
// synthesized.
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

const EXPECTED_TRIGGERS = [
  'message PaymentConfirmed',
  'timer duration PT1H',
  'signal StockReplenished',
  'condition ${amount > 100}',
];

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('every catch keeps its trigger and payload, in order, at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(triggerSignatures(ir), `triggers differ in ${label}`).toEqual(
        EXPECTED_TRIGGERS,
      );
    }
  });

  it('no synthesized Catch_ id token leaks into the decompiled source', () => {
    // `await` has no name slot, so the decompiler prints the trigger and its
    // payload, never the synthesized goto-target id.
    expect(rt.dslPrime).not.toMatch(/Catch_/);
  });
});
