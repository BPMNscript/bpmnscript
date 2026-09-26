import { describe, it, expect } from 'vitest';
import { normalizeIr } from './normalize-ir.js';
import { gatewayDefaultFlowId, isGateway } from '@bpmn-script/transform';
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

  it.each([
    [
      'the host',
      boundary('X', 'Pack', { kind: 'error', errorCode: 'A' }),
      boundary('Y', 'Ship', { kind: 'error', errorCode: 'A' }),
    ],
    [
      'the interrupting flag',
      boundary('X', 'Pack', { kind: 'message', messageName: 'Cancel' }),
      boundary('Y', 'Pack', { kind: 'message', messageName: 'Cancel' }, false),
    ],
  ])(
    'two boundaries alike in all but %s get distinct ids without a positional suffix',
    (_axis, a, b) => {
      // Drop the axis from the signature and the two collapse onto one
      // canonical id told apart only by `#1`.
      const ids = boundaryIds(
        process(
          [
            { kind: 'userTask', id: 'Pack' },
            { kind: 'userTask', id: 'Ship' },
            a,
            b,
          ],
          [],
        ),
      );
      expect(ids).toHaveLength(2);
      expect(ids.filter((id) => id.includes('#'))).toEqual([]);
    },
  );

  it('re-keys gateways and boundaries alone: a task and an end event keep their ids, and only the gateway loses its name', () => {
    const ir = process(
      [
        { kind: 'userTask', id: 'Review', name: 'Review the claim' },
        { kind: 'exclusiveGateway', id: 'Decide', name: 'Approved?' },
        boundary('Timeout_Boundary', 'Review', TIMER_PT2H),
        { kind: 'endEvent', id: 'EndEvent_Timeout_Boundary' },
      ],
      [{ id: 'Flow_1', sourceRef: 'Review', targetRef: 'Decide' }],
    );

    expect(normalizeIr(ir).flowElements).toEqual([
      {
        kind: 'boundaryEvent',
        id: 'Boundary_[host:Review]_[trigger:timer]_[code:duration PT2H]_[interrupting]',
        attachedToRef: 'Review',
        eventDefinition: TIMER_PT2H,
      },
      { kind: 'endEvent', id: 'EndEvent_Timeout_Boundary' },
      {
        kind: 'exclusiveGateway',
        id: 'Gateway_exclusiveGateway_[in:Review]_[out:]',
      },
      { kind: 'userTask', id: 'Review', name: 'Review the claim' },
    ]);
  });
});

describe('normalizeIr: gateway re-key', () => {
  it('gives two structurally identical inclusive forks one canonical id, and re-keys the default flow with them', () => {
    // Same shape, different authored ids: the fork, the join and every flow
    // between them must canonicalize equal, `defaultFlowId` included.
    const shape = (fork: string, join: string, dflt: string): BpmnProcess =>
      process(
        [
          { kind: 'inclusiveGateway', id: fork, defaultFlowId: dflt },
          { kind: 'userTask', id: 'Review' },
          { kind: 'userTask', id: 'Skip' },
          { kind: 'inclusiveGateway', id: join },
        ],
        [
          {
            id: 'Flow_1',
            sourceRef: fork,
            targetRef: 'Review',
            conditionExpression: '${big}',
          },
          { id: dflt, sourceRef: fork, targetRef: 'Skip' },
          { id: 'Flow_3', sourceRef: 'Review', targetRef: join },
          { id: 'Flow_4', sourceRef: 'Skip', targetRef: join },
        ],
      );

    const authored = normalizeIr(shape('Any', 'AllDone', 'ToSkip'));
    const synthesized = normalizeIr(
      shape(
        'Gateway_p_0_fork',
        'Gateway_p_0_join',
        'Flow_Gateway_p_0_fork_default',
      ),
    );

    expect(authored).toEqual(synthesized);
    const defaultOf = (ir: BpmnProcess): string | undefined =>
      ir.flowElements
        .filter(isGateway)
        .map(gatewayDefaultFlowId)
        .find((id) => id !== undefined);
    expect(defaultOf(authored)).not.toBe('ToSkip');
    expect(
      authored.sequenceFlows.some((sf) => sf.id === defaultOf(authored)),
    ).toBe(true);
  });

  // Revert: the `subProcess` branch returning its normalized container
  // without `reKeyedDefault` leaves the block row's default at `Flow_2`.
  it.each([
    [
      'a task naming a generated route as its default',
      'userTask',
      'Flow_2',
      'Flow_Triage_Skip',
    ],
    [
      'a block naming a generated route as its default',
      'subProcess',
      'Flow_2',
      'Flow_Triage_Skip',
    ],
    ['a task naming no default', 'userTask', undefined, undefined],
  ] as const)(
    "re-keys %s's defaultFlowId with the flow it names, and adds none where there is none",
    (_title, kind, authored, expected) => {
      const triage: FlowElement =
        kind === 'subProcess'
          ? { kind, id: 'Triage', flowElements: [], sequenceFlows: [] }
          : { kind, id: 'Triage' };
      const ir = process(
        [
          {
            ...triage,
            ...(authored === undefined ? {} : { defaultFlowId: authored }),
          },
          { kind: 'userTask', id: 'Review' },
          { kind: 'userTask', id: 'Skip' },
        ],
        [
          {
            id: 'Flow_1',
            sourceRef: 'Triage',
            targetRef: 'Review',
            conditionExpression: '${big}',
          },
          { id: 'Flow_2', sourceRef: 'Triage', targetRef: 'Skip' },
        ],
      );
      const normalized = normalizeIr(ir);
      expect(normalized.flowElements.find((fe) => fe.id === 'Triage')).toEqual({
        ...triage,
        ...(expected === undefined ? {} : { defaultFlowId: expected }),
      });
      expect(normalized.sequenceFlows.map((sf) => sf.id)).toEqual([
        'Flow_Triage_Review',
        'Flow_Triage_Skip',
      ]);
    },
  );

  it('re-keys an event-based gateway by its position, the way the other three kinds are re-keyed', () => {
    const race = (id: string): BpmnProcess =>
      process(
        [
          { kind: 'eventBasedGateway', id },
          {
            kind: 'intermediateCatchEvent',
            id: 'Wait',
            eventDefinition: TIMER_PT2H,
          },
          { kind: 'userTask', id: 'Escalate' },
        ],
        [
          { id: 'Flow_1', sourceRef: 'Escalate', targetRef: id },
          { id: 'Flow_2', sourceRef: id, targetRef: 'Wait' },
        ],
      );

    const authored = normalizeIr(race('FirstOf'));
    expect(normalizeIr(race('Gateway_p_1_race'))).toEqual(authored);
    const gateway = authored.flowElements.find(
      (fe) => fe.kind === 'eventBasedGateway',
    );
    expect(gateway?.id).toBe(
      'Gateway_eventBasedGateway_[in:Escalate]_[out:Wait]',
    );
  });
});

describe('normalizeIr: pass-through join', () => {
  const PASS_THROUGH_JOIN = 'Gateway_exclusiveGateway_[in:A,B]_[out:E]';

  // Revert: drop the settings guard in `inlinePassThroughJoins` -> the kept
  // row red, its join inlined and its setting gone from the comparison.
  it.each([
    [
      'a pass-through join carrying a setting is kept and re-keyed',
      { asyncBefore: true as const },
      [
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'userTask', id: 'E' },
        { kind: 'exclusiveGateway', id: PASS_THROUGH_JOIN, asyncBefore: true },
      ],
      [
        {
          id: `Flow_A_${PASS_THROUGH_JOIN}`,
          sourceRef: 'A',
          targetRef: PASS_THROUGH_JOIN,
        },
        {
          id: `Flow_B_${PASS_THROUGH_JOIN}`,
          sourceRef: 'B',
          targetRef: PASS_THROUGH_JOIN,
        },
        {
          id: `Flow_${PASS_THROUGH_JOIN}_E`,
          sourceRef: PASS_THROUGH_JOIN,
          targetRef: 'E',
        },
      ],
    ],
    [
      'a pass-through join carrying none is inlined',
      {},
      [
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'userTask', id: 'E' },
      ],
      [
        { id: 'Flow_A_E', sourceRef: 'A', targetRef: 'E' },
        { id: 'Flow_B_E', sourceRef: 'B', targetRef: 'E' },
      ],
    ],
  ] as const)('%s', (_title, settings, flowElements, sequenceFlows) => {
    const ir = process(
      [
        { kind: 'userTask', id: 'A' },
        { kind: 'userTask', id: 'B' },
        { kind: 'exclusiveGateway', id: 'Gateway_p_1_join', ...settings },
        { kind: 'userTask', id: 'E' },
      ],
      [
        { id: 'Flow_A', sourceRef: 'A', targetRef: 'Gateway_p_1_join' },
        { id: 'Flow_B', sourceRef: 'B', targetRef: 'Gateway_p_1_join' },
        { id: 'Flow_J', sourceRef: 'Gateway_p_1_join', targetRef: 'E' },
      ],
    );

    expect(normalizeIr(ir)).toEqual({
      ...ir,
      flowElements,
      sequenceFlows,
    });
  });
});
