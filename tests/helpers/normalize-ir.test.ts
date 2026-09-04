// Two boundary handlers on one host sharing a trigger kind but differing in
// payload both base to `Boundary_Pack_error`, and moddle may present them on
// import in a different order than the author wrote them. A re-key that ignored
// the payload would collapse them and mask the reordering.
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

function boundary(
  id: string,
  attachedToRef: string,
  eventDefinition: Extract<
    FlowElement,
    { kind: 'boundaryEvent' }
  >['eventDefinition'],
  cancelActivity?: false,
): FlowElement {
  return {
    kind: 'boundaryEvent',
    id,
    attachedToRef,
    eventDefinition,
    ...(cancelActivity === false ? { cancelActivity } : {}),
  };
}

function boundaryIds(ir: BpmnProcess): string[] {
  return normalizeIr(ir)
    .flowElements.filter((fe) => fe.kind === 'boundaryEvent')
    .map((fe) => fe.id);
}

const TIMER_PT2H = {
  kind: 'timer',
  timerKind: 'duration',
  expression: 'PT2H',
} as const;

describe('normalizeIr: boundary-event re-key', () => {
  it('keeps two same-host same-trigger boundary handlers distinct by payload, regardless of authored order', () => {
    const forward = process(
      [
        { kind: 'userTask', id: 'Pack' },
        boundary('Boundary_Pack_error', 'Pack', {
          kind: 'error',
          errorCode: 'A',
        }),
        boundary('Boundary_Pack_error_2', 'Pack', {
          kind: 'error',
          errorCode: 'B',
        }),
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
        boundary('Timeout_Boundary_1', 'Pack', {
          kind: 'error',
          errorCode: 'B',
        }),
        boundary('Timeout_Boundary_2', 'Pack', {
          kind: 'error',
          errorCode: 'A',
        }),
      ],
      [
        { id: 'Flow_X', sourceRef: 'Timeout_Boundary_1', targetRef: 'Pack' },
        { id: 'Flow_Y', sourceRef: 'Timeout_Boundary_2', targetRef: 'Pack' },
      ],
    );

    expect(normalizeIr(forward)).toEqual(normalizeIr(reversed));
    expect(new Set(boundaryIds(forward)).size).toBe(2);
  });

  it('re-keys the sequence flow leaving a boundary event to match its canonical id', () => {
    const ir = process(
      [
        { kind: 'userTask', id: 'Review' },
        boundary('Timeout_Boundary', 'Review', TIMER_PT2H),
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
    const attacher = normalized.flowElements.find(
      (fe) => fe.kind === 'boundaryEvent',
    );

    expect(attacher).toBeDefined();
    expect(attacher?.id).not.toBe('Timeout_Boundary');
    expect(normalized.sequenceFlows[0].sourceRef).toBe(attacher?.id);
    // attachedToRef is an authored host id and is never re-keyed.
    expect(
      attacher && 'attachedToRef' in attacher && attacher.attachedToRef,
    ).toBe('Review');
  });

  it('distinguishes an interrupting boundary from an otherwise-identical non-interrupting one', () => {
    const interrupting = process(
      [
        { kind: 'userTask', id: 'Ship' },
        boundary('A', 'Ship', { kind: 'message', messageName: 'Cancel' }),
      ],
      [],
    );
    const alongside = process(
      [
        { kind: 'userTask', id: 'Ship' },
        boundary(
          'B',
          'Ship',
          { kind: 'message', messageName: 'Cancel' },
          false,
        ),
      ],
      [],
    );

    expect(boundaryIds(interrupting)).not.toEqual(boundaryIds(alongside));
  });

  it('keeps two same-trigger same-payload boundary events on different hosts distinct', () => {
    // Drop the host from the signature and these two collapse to one canonical
    // id with positional suffixes, the exact hazard the re-key removes.
    const ir = process(
      [
        { kind: 'userTask', id: 'Pack' },
        { kind: 'userTask', id: 'Ship' },
        boundary('PackTimeout', 'Pack', { kind: 'error', errorCode: 'X' }),
        boundary('ShipTimeout', 'Ship', { kind: 'error', errorCode: 'X' }),
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
    // again on the way back and needs no canonical mapping.
    const ir = process(
      [
        { kind: 'userTask', id: 'Review' },
        boundary('Timeout_Boundary', 'Review', TIMER_PT2H),
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
