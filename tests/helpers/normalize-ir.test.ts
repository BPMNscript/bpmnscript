/**
 * Focused coverage for the boundary-event re-key in `normalizeIr`, whose failure
 * mode the round-trip suites cover only indirectly: two boundary handlers on one
 * host that share a trigger kind but differ in payload (`on Pack: error "A"` and
 * `on Pack: error "B"`) both base to `Boundary_Pack_error`, and moddle may
 * present them on import in a different order than the author wrote them. A
 * re-key that ignored the payload would collapse the two into one canonical id
 * and mask that reordering.
 */
import { describe, it, expect } from 'vitest';
import { normalizeIr } from './normalize-ir.js';
import type {
  BpmnProcess,
  FlowElement,
  SequenceFlow,
} from '@bpmn-script/transform';

function process(
  flowElements: FlowElement[],
  sequenceFlows: SequenceFlow[],
): BpmnProcess {
  return { id: 'Process_1', isExecutable: true, flowElements, sequenceFlows };
}

describe('normalizeIr — boundary-event re-key', () => {
  it('keeps two same-host same-trigger boundary handlers distinct by payload, regardless of authored order', () => {
    // Two handlers on one host with different error codes are not duplicates
    // under the validator's (host, trigger, code) key, yet both base to
    // `Boundary_Pack_error`. Reversing their order, as moddle may on import,
    // must still produce the same normalized result.
    const forward = process(
      [
        { kind: 'userTask', id: 'Pack' },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Pack_error',
          attachedToRef: 'Pack',
          eventDefinition: { kind: 'error', errorCode: 'A' },
        },
        {
          kind: 'boundaryEvent',
          id: 'Boundary_Pack_error_2',
          attachedToRef: 'Pack',
          eventDefinition: { kind: 'error', errorCode: 'B' },
        },
      ],
      [
        { id: 'Flow_A', sourceRef: 'Boundary_Pack_error', targetRef: 'Pack' },
        {
          id: 'Flow_B',
          sourceRef: 'Boundary_Pack_error_2',
          targetRef: 'Pack',
        },
      ],
    );

    const reversed = process(
      [
        { kind: 'userTask', id: 'Pack' },
        {
          kind: 'boundaryEvent',
          id: 'Timeout_Boundary_1',
          attachedToRef: 'Pack',
          eventDefinition: { kind: 'error', errorCode: 'B' },
        },
        {
          kind: 'boundaryEvent',
          id: 'Timeout_Boundary_2',
          attachedToRef: 'Pack',
          eventDefinition: { kind: 'error', errorCode: 'A' },
        },
      ],
      [
        { id: 'Flow_X', sourceRef: 'Timeout_Boundary_1', targetRef: 'Pack' },
        { id: 'Flow_Y', sourceRef: 'Timeout_Boundary_2', targetRef: 'Pack' },
      ],
    );

    const normalizedForward = normalizeIr(forward);
    const normalizedReversed = normalizeIr(reversed);

    expect(normalizedForward).toEqual(normalizedReversed);

    // The two handlers must not collapse to one canonical id.
    const boundaryIds = normalizedForward.flowElements
      .filter((fe) => fe.kind === 'boundaryEvent')
      .map((fe) => fe.id);
    expect(new Set(boundaryIds).size).toBe(2);
  });

  it('re-keys the sequence flow leaving a boundary event to match its canonical id', () => {
    const ir = process(
      [
        { kind: 'userTask', id: 'Review' },
        {
          kind: 'boundaryEvent',
          id: 'Timeout_Boundary',
          attachedToRef: 'Review',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'duration',
            expression: 'PT2H',
          },
        },
        { kind: 'userTask', id: 'Escalate' },
      ],
      [
        {
          id: 'Flow_Timeout',
          sourceRef: 'Timeout_Boundary',
          targetRef: 'Escalate',
        },
      ],
    );

    const normalized = normalizeIr(ir);
    const boundary = normalized.flowElements.find(
      (fe) => fe.kind === 'boundaryEvent',
    );
    const flow = normalized.sequenceFlows[0];

    expect(boundary).toBeDefined();
    expect(boundary?.id).not.toBe('Timeout_Boundary');
    // The outgoing flow's sourceRef follows the re-keyed boundary id.
    expect(flow.sourceRef).toBe(boundary?.id);
    // attachedToRef is an authored host id and is never re-keyed.
    expect(
      boundary && 'attachedToRef' in boundary && boundary.attachedToRef,
    ).toBe('Review');
  });

  it('distinguishes an interrupting boundary from an otherwise-identical non-interrupting one', () => {
    const interrupting = process(
      [
        { kind: 'userTask', id: 'Ship' },
        {
          kind: 'boundaryEvent',
          id: 'A',
          attachedToRef: 'Ship',
          eventDefinition: { kind: 'message', messageName: 'Cancel' },
        },
      ],
      [],
    );
    const alongside = process(
      [
        { kind: 'userTask', id: 'Ship' },
        {
          kind: 'boundaryEvent',
          id: 'B',
          attachedToRef: 'Ship',
          eventDefinition: { kind: 'message', messageName: 'Cancel' },
          cancelActivity: false,
        },
      ],
      [],
    );

    const normalizedInterrupting = normalizeIr(interrupting);
    const normalizedAlongside = normalizeIr(alongside);

    const interruptingId = normalizedInterrupting.flowElements.find(
      (fe) => fe.kind === 'boundaryEvent',
    )?.id;
    const alongsideId = normalizedAlongside.flowElements.find(
      (fe) => fe.kind === 'boundaryEvent',
    )?.id;

    expect(interruptingId).not.toBe(alongsideId);
  });

  it('keeps two same-trigger same-payload boundary events on different hosts distinct', () => {
    // Without the host in the signature these two collapse to one canonical id
    // and pick up positional suffixes, which is exactly the reordering hazard
    // the re-key exists to remove.
    const ir = process(
      [
        { kind: 'userTask', id: 'Pack' },
        { kind: 'userTask', id: 'Ship' },
        {
          kind: 'boundaryEvent',
          id: 'PackTimeout',
          attachedToRef: 'Pack',
          eventDefinition: { kind: 'error', errorCode: 'X' },
        },
        {
          kind: 'boundaryEvent',
          id: 'ShipTimeout',
          attachedToRef: 'Ship',
          eventDefinition: { kind: 'error', errorCode: 'X' },
        },
      ],
      [],
    );

    const ids = normalizeIr(ir)
      .flowElements.filter((fe) => fe.kind === 'boundaryEvent')
      .map((fe) => fe.id);
    expect(new Set(ids).size).toBe(2);
    // A positional suffix would mean the two signatures had collided.
    for (const id of ids) expect(id).not.toContain('#');
  });

  it('leaves every end event untouched, including one named after a boundary event', () => {
    // The printer emits a terminal end under its literal id, so it is authored
    // again on the way back and needs no canonical mapping, even when its name
    // echoes a re-keyed boundary.
    const ir = process(
      [
        { kind: 'userTask', id: 'Review' },
        {
          kind: 'boundaryEvent',
          id: 'Timeout_Boundary',
          attachedToRef: 'Review',
          eventDefinition: {
            kind: 'timer',
            timerKind: 'duration',
            expression: 'PT2H',
          },
        },
        { kind: 'endEvent', id: 'EndEvent_Timeout_Boundary' },
      ],
      [],
    );

    const ids = normalizeIr(ir)
      .flowElements.filter((fe) => fe.kind === 'endEvent')
      .map((fe) => fe.id);
    expect(ids).toEqual(['EndEvent_Timeout_Boundary']);
  });

  it('leaves a boundary-free container byte-identical to the un-normalized shape', () => {
    const ir = process([{ kind: 'userTask', id: 'Solo' }], []);

    expect(normalizeIr(ir)).toEqual(ir);
  });
});
