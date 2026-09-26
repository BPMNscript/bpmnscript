/**
 * The templates are frozen by ADR 0010, Use Deterministic Structural Ids for
 * Synthesized BPMN Elements, and the validator reserves every form they mint
 * from a pattern list it spells itself, so each row pins the exact id and
 * that `isReservedName` refuses it.
 */

import { describe, expect, it } from 'vitest';
import { isReservedName } from '@bpmn-script/language';
import {
  isMintedEndId,
  isMintedStartId,
  isWritableName,
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
  mintPrintableName,
  resolveCollision,
} from '../src/synthesize-ids.js';

describe('every template mints its documented form, which the validator reserves', () => {
  it.each<[string, () => string, string?]>([
    ['Gateway_AmountCheck_split', () => makeGatewaySplitId('AmountCheck')],
    ['Gateway_AmountCheck_join', () => makeGatewayJoinId('AmountCheck')],
    ['Gateway_Step1_fork', () => makeGatewayForkId('Step1')],
    ['Gateway_OrderWait_race', () => makeGatewayRaceId('OrderWait')],
    ['Gateway_MyWhile_loop', () => makeGatewayLoopId('MyWhile')],
    [
      'Flow_Gateway_AmountCheck_split_default',
      () => makeDefaultFlowId('Gateway_AmountCheck_split'),
    ],
    [
      'Flow_ReviewInvoice_AmountCheck',
      () => makeSequenceFlowId('ReviewInvoice', 'AmountCheck', new Set()),
    ],
    [
      'StartEvent_invoice-approval',
      () => makeStartEventId('invoice-approval', new Set()),
      'invoice-approval',
    ],
    [
      'EndEvent_invoice-approval',
      () => makeEndEventId('invoice-approval', new Set()),
      'invoice-approval',
    ],
    [
      'Throw_invoice-approval_2_t_0',
      () => makeThrowEventId('invoice-approval_2_t_0'),
    ],
    [
      'EventSubProcess_invoice-approval_0',
      () => makeEventSubProcessId('invoice-approval_0'),
    ],
    [
      'Catch_invoice-approval_1_c_0',
      () => makeIntermediateCatchEventId('invoice-approval_1_c_0'),
    ],
    [
      'Boundary_Pack_error',
      () => makeBoundaryEventId('Pack', 'error', new Set()),
    ],
    [
      'Boundary_Pack_timer_2',
      () =>
        makeBoundaryEventId('Pack', 'timer', new Set(['Boundary_Pack_timer'])),
    ],
    [
      'Boundary_Pack_timer_3',
      () =>
        makeBoundaryEventId(
          'Pack',
          'timer',
          new Set(['Boundary_Pack_timer', 'Boundary_Pack_timer_2']),
        ),
    ],
    // A boundary escape's end and a handler body's own start: minted off a
    // coordinate no container name reaches, so the validator reserves the
    // prefix rather than the exact form (no `container` argument here).
    [
      'EndEvent_Boundary_Pack_timer',
      () => makeEndEventId('Boundary_Pack_timer', new Set()),
    ],
    [
      'StartEvent_EventSubProcess_p_1',
      () => makeStartEventId('EventSubProcess_p_1', new Set()),
    ],
  ])('%s', (expected, make, container) => {
    const id = make();
    expect(id).toBe(expected);
    // The validator's package cannot import these templates, so this row is
    // what keeps its pattern list and the templates the same set.
    expect(isReservedName(id, container)).toBe(true);
    if (container !== undefined) expect(isReservedName(id)).toBe(false);
  });

  // The suffixed id minted past a taken name is an ordinary name: the
  // validator does not reserve it, and the printer does not elide it.
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

describe('mintPrintableName', () => {
  it.each([
    ['a dot becomes an underscore', 'Task.1', false, 'Task_1'],
    ['a keyword takes a leading underscore', 'user', false, '_user'],
    ['a trailing hyphen becomes an underscore', 'Review-', false, 'Review_'],
    ['every non-word character becomes one', 'WFP-6-', false, 'WFP_6_'],
    ['a leading digit takes a leading underscore', '1st', false, '_1st'],
    [
      'an inner hyphen is a name already',
      'invoice-approval',
      true,
      'invoice-approval',
    ],
  ])('%s', (_title, id, writable, expected) => {
    expect([isWritableName(id), mintPrintableName(id)]).toEqual([
      writable,
      expected,
    ]);
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
