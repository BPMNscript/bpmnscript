// The templates are frozen (ADR 0010) and the validator reserves their forms from its own pattern list.

import { describe, expect, it } from 'vitest';
import { isReservedName } from '@bpmn-script/language';
import * as synthesizeIds from '../src/synthesize-ids.js';
import {
  boundaryEventIdBase,
  endIdOf,
  isMintedEndId,
  isMintedStartId,
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeGatewayRaceId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  makeThrowEventId,
  makeEventSubProcessId,
  makeBoundaryEventId,
  makeIntermediateCatchEventId,
  resolveCollision,
} from '../src/synthesize-ids.js';
import { irToXml } from '../src/ir-to-xml.js';
import { chainedSub, minimalProcess } from './helpers/ir-fixtures.js';

type Maker = (...args: never[]) => string;

// A container's own minted start and end are reserved only against that container, named in the last column.
const MINTED: [
  expected: string,
  maker: Maker,
  args: unknown[],
  container?: string,
][] = [
  ['Gateway_AmountCheck_split', makeGatewaySplitId, ['AmountCheck']],
  ['Gateway_AmountCheck_join', makeGatewayJoinId, ['AmountCheck']],
  ['Gateway_Step1_fork', makeGatewayForkId, ['Step1']],
  ['Gateway_OrderWait_race', makeGatewayRaceId, ['OrderWait']],
  ['Gateway_MyWhile_loop', makeGatewayLoopId, ['MyWhile']],
  [
    'Flow_Gateway_AmountCheck_split_default',
    makeDefaultFlowId,
    ['Gateway_AmountCheck_split'],
  ],
  [
    'Flow_ReviewInvoice_AmountCheck',
    makeSequenceFlowId,
    ['ReviewInvoice', 'AmountCheck', new Set()],
  ],
  [
    'StartEvent_invoice-approval',
    makeStartEventId,
    ['invoice-approval', new Set()],
    'invoice-approval',
  ],
  [
    'EndEvent_invoice-approval',
    makeEndEventId,
    ['invoice-approval', new Set()],
    'invoice-approval',
  ],
  [
    'Throw_invoice-approval_2_t_0',
    makeThrowEventId,
    ['invoice-approval_2_t_0'],
  ],
  [
    'EventSubProcess_invoice-approval_0',
    makeEventSubProcessId,
    ['invoice-approval_0'],
  ],
  [
    'Catch_invoice-approval_1_c_0',
    makeIntermediateCatchEventId,
    ['invoice-approval_1_c_0'],
  ],
  ['Boundary_Pack_error', makeBoundaryEventId, ['Pack', 'error', new Set()]],
  [
    'Boundary_Pack_timer_2',
    makeBoundaryEventId,
    ['Pack', 'timer', new Set(['Boundary_Pack_timer'])],
  ],
  [
    'Boundary_Pack_timer_3',
    makeBoundaryEventId,
    [
      'Pack',
      'timer',
      new Set(['Boundary_Pack_timer', 'Boundary_Pack_timer_2']),
    ],
  ],
  ['Boundary_Pack_timer', boundaryEventIdBase, ['Pack', 'timer']],
  // Minted off a coordinate no container name reaches, so reserved by prefix.
  [
    'EndEvent_Boundary_Pack_timer',
    makeEndEventId,
    ['Boundary_Pack_timer', new Set()],
  ],
  [
    'StartEvent_EventSubProcess_p_1',
    makeStartEventId,
    ['EventSubProcess_p_1', new Set()],
  ],
  ['EndEvent_EventSubProcess_p_1', endIdOf, ['EventSubProcess_p_1']],
];

// The exports that read, claim or suffix an id rather than mint one of their own shape.
const NOT_MINTERS = new Set<unknown>([
  synthesizeIds.isMintedStartId,
  synthesizeIds.isMintedEndId,
  synthesizeIds.claimId,
  synthesizeIds.claimDeclarationName,
  synthesizeIds.resolveCollision,
]);

describe('every template mints its documented form, which the validator reserves', () => {
  it.each(MINTED)('%s', (expected, maker, args, container) => {
    const id = (maker as (...args: unknown[]) => string)(...args);
    expect(id).toBe(expected);
    expect(isReservedName(id, container)).toBe(true);
    if (container !== undefined) expect(isReservedName(id)).toBe(false);
  });

  it('no exported id maker is missing from that table', () => {
    const covered = new Set<unknown>(MINTED.map(([, maker]) => maker));
    expect(
      Object.entries(synthesizeIds)
        .filter(
          ([, value]) =>
            typeof value === 'function' &&
            !NOT_MINTERS.has(value) &&
            !covered.has(value),
        )
        .map(([name]) => name),
    ).toEqual([]);
  });

  it('every diagram id the writer emits, a sub-process expansion included, is reserved', async () => {
    const xml = await irToXml(
      minimalProcess([chainedSub('Sub', [{ kind: 'task', id: 'T' }])]),
    );
    expect(
      [...xml.matchAll(/<bpmndi:\w+ id="([^"]+)"/g)].map(([, id]) => [
        id,
        isReservedName(id!),
      ]),
    ).toEqual([
      ['BPMNDiagram_p', true],
      ['BPMNPlane_p', true],
      ['Sub_di', true],
      ['T_di', true],
    ]);
  });

  it('the minted start and end are recognized exactly, per container', () => {
    const boundaries = ['Boundary_Pack_error'];
    expect(
      [
        'StartEvent_p',
        'StartEvent_1',
        'StartEvent_p_2',
        'StartEvent_q',
        'EndEvent_p',
        'EndEvent_Boundary_Pack_error',
        'EndEvent_p_2',
        'EndEvent_q',
      ].map((id) => [
        id,
        isMintedStartId(id, 'p'),
        isMintedEndId(id, 'p', boundaries),
      ]),
    ).toEqual([
      ['StartEvent_p', true, false],
      ['StartEvent_1', false, false],
      ['StartEvent_p_2', false, false],
      ['StartEvent_q', false, false],
      ['EndEvent_p', false, true],
      ['EndEvent_Boundary_Pack_error', false, true],
      ['EndEvent_p_2', false, false],
      ['EndEvent_q', false, false],
    ]);
  });
});

describe('a template whose base an author can take claims its result and suffixes past a taken one', () => {
  it.each([
    ['StartEvent_P', (taken: Set<string>) => makeStartEventId('P', taken)],
    ['EndEvent_P', (taken: Set<string>) => makeEndEventId('P', taken)],
    [
      'Boundary_Pack_error',
      (taken: Set<string>) => makeBoundaryEventId('Pack', 'error', taken),
    ],
    ['Flow_A_B', (taken: Set<string>) => makeSequenceFlowId('A', 'B', taken)],
  ])('%s, then _2, then _3, each claimed', (base, make) => {
    const taken = new Set<string>();
    const minted = [make(taken), make(taken), make(taken)];
    expect(minted).toEqual([base, `${base}_2`, `${base}_3`]);
    expect([...taken]).toEqual(minted);
  });
});

describe('resolveCollision', () => {
  it.each([
    ['A', ['B', 'C'], 'A'],
    ['X', ['X', 'X_2', 'X_3', 'X_4'], 'X_5'],
  ] as const)(
    '%s against %j resolves to %s and leaves the set alone',
    (base, taken, expected) => {
      const set = new Set(taken);
      expect(resolveCollision(base, set)).toBe(expected);
      expect([...set]).toEqual([...taken]);
    },
  );
});
