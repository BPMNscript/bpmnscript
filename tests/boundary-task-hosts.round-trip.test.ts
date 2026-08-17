/**
 * Frozen golden and round-trip proof that a boundary handler attaches cleanly to
 * a script task and to a service task bound through its `topic` attribute, the
 * external-worker binding no other golden covers.
 *
 * The fixture is a checkout narrative with one boundary handler per step: an
 * interrupting error boundary on the class-bound service task, a
 * non-interrupting timer boundary on the script task, and an interrupting
 * message boundary on the topic-bound service task.
 */

import { describe, it, expect } from 'vitest';

import type { FlowContainer, FlowElement } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('boundary-task-hosts', {
  dslPrimeFrom: 'frozen',
  recompile: 'errors-standalone',
});

type BoundaryEvent = Extract<FlowElement, { kind: 'boundaryEvent' }>;

function boundaryEvents(container: FlowContainer): BoundaryEvent[] {
  return container.flowElements.filter(
    (fe): fe is BoundaryEvent => fe.kind === 'boundaryEvent',
  );
}

/**
 * Everything about a boundary event that is not its id: host, trigger kind,
 * caught payload, and whether it cancels its host.
 */
function attachmentSignature(boundary: BoundaryEvent): string {
  const def = boundary.eventDefinition;
  const payload =
    def.kind === 'error'
      ? (def.errorCode ?? '<catch-all>')
      : def.kind === 'message'
        ? def.messageName
        : def.kind === 'timer'
          ? `${def.timerKind} ${def.expression}`
          : '<none>';
  const cancels =
    boundary.cancelActivity === false ? 'alongside' : 'interrupting';
  return `${boundary.attachedToRef} ${def.kind} ${payload} ${cancels}`;
}

function attachmentSignatures(container: FlowContainer): string[] {
  return boundaryEvents(container).map(attachmentSignature).sort();
}

/**
 * The three boundary events the fixture authors, one per task host kind. Frozen
 * here so a hop that drops a host, flips `cancelActivity`, or loses a trigger
 * payload fails with a readable diff rather than a deep-equality dump.
 */
const EXPECTED_ATTACHMENTS = [
  'ChargeCard error PAYMENT_DECLINED interrupting',
  'ComputeShipping timer duration PT1H alongside',
  'PrintLabel message ExpediteRequested interrupting',
].sort();

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('each host carries its boundary event, pinned by attachedToRef', () => {
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
    );
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ComputeShipping_timer" cancelActivity="false" attachedToRef="ComputeShipping">',
    );
    expect(rt.generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_PrintLabel_message" attachedToRef="PrintLabel">',
    );
  });
});

describe('idempotence: golden .bpmn → IR₂ → DSL′ → IR₃', () => {
  it("each boundary's host, trigger, payload, and cancelActivity survive the round-trip", () => {
    expect(attachmentSignatures(rt.ir1)).toEqual(EXPECTED_ATTACHMENTS);
    expect(attachmentSignatures(rt.ir3)).toEqual(EXPECTED_ATTACHMENTS);
  });
});
