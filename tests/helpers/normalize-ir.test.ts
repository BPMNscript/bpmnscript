import { describe, it, expect } from 'vitest';
import { normalizeIr } from './normalize-ir.js';
import type {
  BpmnProcess,
  EventDefinition,
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
  eventDefinition: EventDefinition,
  cancelActivity?: false,
): FlowElement {
  return {
    kind: 'boundaryEvent',
    id,
    attachedToRef,
    eventDefinition,
    ...(cancelActivity === false ? { cancelActivity } : {}),
  } as FlowElement;
}

const ERROR_A = { kind: 'error', errorCode: 'A' } as const;
const ERROR_B = { kind: 'error', errorCode: 'B' } as const;
const CANCEL = { kind: 'message', messageName: 'Cancel' } as const;
const TIMER_PT2H = {
  kind: 'timer',
  timerKind: 'duration',
  expression: 'PT2H',
} as const;

describe('normalizeIr', () => {
  // Each boundary pair differs in one signature axis (payload, host,
  // interrupting flag); dropping that axis collapses the pair onto `#1`.
  it('re-keys boundaries and gateways by content regardless of authored ids and order, and leaves tasks and events alone', () => {
    const tasks: FlowElement[] = [
      { kind: 'userTask', id: 'Pack', name: 'Pack the order' },
      { kind: 'userTask', id: 'Ship' },
      { kind: 'endEvent', id: 'EndEvent_Timeout_Boundary' },
    ];
    const authored = process(
      [
        ...tasks,
        { kind: 'exclusiveGateway', id: 'Decide', name: 'Packed?' },
        boundary('Boundary_Pack_error', 'Pack', ERROR_A),
        boundary('Boundary_Pack_error_2', 'Pack', ERROR_B),
        boundary('Boundary_Ship_error', 'Ship', ERROR_A),
        boundary('Boundary_Pack_message', 'Pack', CANCEL),
        boundary('Boundary_Pack_message_2', 'Pack', CANCEL, false),
      ],
      [
        { id: 'Flow_1', sourceRef: 'Pack', targetRef: 'Decide' },
        { id: 'Flow_2', sourceRef: 'Boundary_Pack_error', targetRef: 'Ship' },
      ],
    );
    const reordered = process(
      [
        boundary('B5', 'Pack', CANCEL, false),
        boundary('B4', 'Pack', CANCEL),
        boundary('B3', 'Ship', ERROR_A),
        boundary('B2', 'Pack', ERROR_B),
        boundary('B1', 'Pack', ERROR_A),
        { kind: 'exclusiveGateway', id: 'Gateway_p_0_split' },
        ...tasks,
      ],
      [
        { id: 'Flow_X', sourceRef: 'Pack', targetRef: 'Gateway_p_0_split' },
        { id: 'Flow_Y', sourceRef: 'B1', targetRef: 'Ship' },
      ],
    );

    const errorA =
      'Boundary_[host:Pack]_[trigger:error]_[code:A]_[interrupting]';
    const normalized = normalizeIr(authored);
    expect(normalizeIr(reordered)).toEqual(normalized);
    expect(normalized.flowElements).toEqual([
      boundary(errorA, 'Pack', ERROR_A),
      boundary(
        'Boundary_[host:Pack]_[trigger:error]_[code:B]_[interrupting]',
        'Pack',
        ERROR_B,
      ),
      boundary(
        'Boundary_[host:Pack]_[trigger:message]_[code:Cancel]_[interrupting]',
        'Pack',
        CANCEL,
      ),
      boundary(
        'Boundary_[host:Pack]_[trigger:message]_[code:Cancel]_[non-interrupting]',
        'Pack',
        CANCEL,
        false,
      ),
      boundary(
        'Boundary_[host:Ship]_[trigger:error]_[code:A]_[interrupting]',
        'Ship',
        ERROR_A,
      ),
      { kind: 'endEvent', id: 'EndEvent_Timeout_Boundary' },
      {
        kind: 'exclusiveGateway',
        id: 'Gateway_exclusiveGateway_[in:Pack]_[out:]',
      },
      { kind: 'userTask', id: 'Pack', name: 'Pack the order' },
      { kind: 'userTask', id: 'Ship' },
    ]);
    expect(normalized.sequenceFlows.map((sf) => sf.id)).toEqual([
      `Flow_${errorA}_Ship`,
      'Flow_Pack_Gateway_exclusiveGateway_[in:Pack]_[out:]',
    ]);
  });

  it.each([
    {
      title: 'an inclusive fork and join, default flow re-keyed with the fork',
      shape: (fork: string, join: string, dflt: string): BpmnProcess =>
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
        ),
      authored: ['Any', 'AllDone', 'ToSkip'] as const,
      synthesized: [
        'Gateway_p_0_fork',
        'Gateway_p_0_join',
        'Flow_Gateway_p_0_fork_default',
      ] as const,
      gateways: [
        {
          kind: 'inclusiveGateway',
          id: 'Gateway_inclusiveGateway_[in:]_[out:Review,Skip]',
          defaultFlowId:
            'Flow_Gateway_inclusiveGateway_[in:]_[out:Review,Skip]_Skip',
        },
        {
          kind: 'inclusiveGateway',
          id: 'Gateway_inclusiveGateway_[in:Review,Skip]_[out:]',
        },
      ],
    },
    {
      title: 'an event-based race',
      shape: (id: string): BpmnProcess =>
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
        ),
      authored: ['FirstOf'] as const,
      synthesized: ['Gateway_p_1_race'] as const,
      gateways: [
        {
          kind: 'eventBasedGateway',
          id: 'Gateway_eventBasedGateway_[in:Escalate]_[out:Wait]',
        },
      ],
    },
  ])(
    'keys $title by position, so authored and synthesized ids meet',
    ({ shape, authored, synthesized, gateways }) => {
      const build = shape as (...ids: string[]) => BpmnProcess;
      const normalized = normalizeIr(build(...authored));
      expect(normalizeIr(build(...synthesized))).toEqual(normalized);
      expect(
        normalized.flowElements.filter((fe) => fe.kind.endsWith('Gateway')),
      ).toEqual(gateways);
    },
  );

  // Revert: the `subProcess` branch returning its normalized container
  // without `reKeyedDefault` leaves the block row's default at `Flow_2`.
  it.each([
    [
      'a task naming a generated route',
      'userTask',
      'Flow_2',
      'Flow_Triage_Skip',
    ],
    [
      'a block naming a generated route',
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
      const normalized = normalizeIr(
        process(
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
        ),
      );
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

  const JOIN = 'Gateway_exclusiveGateway_[in:A,B]_[out:E]';
  const TASKS: FlowElement[] = [
    { kind: 'userTask', id: 'A' },
    { kind: 'userTask', id: 'B' },
    { kind: 'userTask', id: 'E' },
  ];

  // Revert: drop the settings guard in `inlinePassThroughJoins` -> the kept
  // row red, its join inlined and its setting gone from the comparison.
  it.each([
    [
      'a pass-through join carrying a setting is kept and re-keyed',
      { asyncBefore: true as const },
      [...TASKS, { kind: 'exclusiveGateway', id: JOIN, asyncBefore: true }],
      [
        { id: `Flow_A_${JOIN}`, sourceRef: 'A', targetRef: JOIN },
        { id: `Flow_B_${JOIN}`, sourceRef: 'B', targetRef: JOIN },
        { id: `Flow_${JOIN}_E`, sourceRef: JOIN, targetRef: 'E' },
      ],
    ],
    [
      'a pass-through join carrying none is inlined',
      {},
      TASKS,
      [
        { id: 'Flow_A_E', sourceRef: 'A', targetRef: 'E' },
        { id: 'Flow_B_E', sourceRef: 'B', targetRef: 'E' },
      ],
    ],
  ])('%s', (_title, settings, flowElements, sequenceFlows) => {
    const ir = process(
      [
        ...TASKS,
        { kind: 'exclusiveGateway', id: 'Gateway_p_1_join', ...settings },
      ],
      [
        { id: 'Flow_A', sourceRef: 'A', targetRef: 'Gateway_p_1_join' },
        { id: 'Flow_B', sourceRef: 'B', targetRef: 'Gateway_p_1_join' },
        { id: 'Flow_J', sourceRef: 'Gateway_p_1_join', targetRef: 'E' },
      ],
    );
    expect(normalizeIr(ir)).toEqual({ ...ir, flowElements, sequenceFlows });
  });
});
