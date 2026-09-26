/**
 * The id templates are shared by the desugarer, the emitter, and the round-trip
 * normalizer, so changing one here requires a matching change there.
 *
 *   Gateway_<X>_split         XOR split gateway for an `if` statement with id X
 *   Gateway_<X>_join          XOR join gateway for an `if` statement with id X
 *   Gateway_<X>_fork          AND fork (parallel) gateway for a `parallel` block X
 *   Gateway_<X>_join          AND join (parallel) gateway for a `parallel` block X
 *   Gateway_<X>_race          Event-based gateway for a multi-branch `await` X
 *   Gateway_<X>_loop          XOR loop-head gateway for a `while` statement X
 *   Flow_<gatewayId>_default  Default (else-branch) flow out of a gateway
 *   Flow_<sourceId>_<targetId>  Sequence flow (plain); duplicate pairs get _2, _3, ...
 *   StartEvent_<containerId>  Implicit start event of a container
 *   EndEvent_<containerId>    Implicit end event of a container, or of a boundary escape
 *   Throw_<X>                 Unnamed `throw`/`emit` event at coordinate X
 *   EventSubProcess_<X>       `on` handler (event sub-process) at coordinate X
 *   Boundary_<hostId>_<trigger>  Hosted `on <Host>: <trigger>` handler; duplicates get _2, _3, ...
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

// ---------------------------------------------------------------------------
// Determinism: a collision with an author-supplied id resolves to a stable
// suffixed id, and the resolved id is recorded in the taken set
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('makeStartEventId resolves a collision with an author id and records it', () => {
    // A task literally named `StartEvent_P` in process `P` collides with the
    // implicit start id; the synthesizer must suffix it deterministically.
    const taken = new Set<string>(['StartEvent_P']);
    const id = makeStartEventId('P', taken);
    expect(id).toBe('StartEvent_P_2');
    expect(taken.has('StartEvent_P_2')).toBe(true);
  });

  it('makeBoundaryEventId resolves a collision and records it in taken', () => {
    const taken = new Set<string>(['Boundary_Pack_error']);
    const id = makeBoundaryEventId('Pack', 'error', taken);
    expect(id).toBe('Boundary_Pack_error_2');
    expect(taken.has('Boundary_Pack_error_2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural stability: templates match the exact documented forms, and every
// form is one the validator reserves; a start or end only inside the container
// that seeds it
// ---------------------------------------------------------------------------

describe('structural stability', () => {
  it.each<[string, () => string, string?]>([
    ['Gateway_AmountCheck_split', () => makeGatewaySplitId('AmountCheck')],
    ['Gateway_Step1_split', () => makeGatewaySplitId('Step1')],
    ['Gateway_AmountCheck_join', () => makeGatewayJoinId('AmountCheck')],
    ['Gateway_OuterIf_join', () => makeGatewayJoinId('OuterIf')],
    ['Gateway_Step1_fork', () => makeGatewayForkId('Step1')],
    ['Gateway_ParallelBlock_fork', () => makeGatewayForkId('ParallelBlock')],
    ['Gateway_p_3_race', () => makeGatewayRaceId('p_3')],
    ['Gateway_OrderWait_race', () => makeGatewayRaceId('OrderWait')],
    ['Gateway_MyWhile_loop', () => makeGatewayLoopId('MyWhile')],
    ['Gateway_RetryLoop_loop', () => makeGatewayLoopId('RetryLoop')],
    [
      'Flow_Gateway_AmountCheck_split_default',
      () => makeDefaultFlowId('Gateway_AmountCheck_split'),
    ],
    ['Flow_Gateway_X_join_default', () => makeDefaultFlowId('Gateway_X_join')],
    [
      'StartEvent_invoice-approval',
      () => makeStartEventId('invoice-approval', new Set()),
      'invoice-approval',
    ],
    [
      'StartEvent_my-process',
      () => makeStartEventId('my-process', new Set()),
      'my-process',
    ],
    [
      'EndEvent_invoice-approval',
      () => makeEndEventId('invoice-approval', new Set()),
      'invoice-approval',
    ],
    ['Throw_p_1', () => makeThrowEventId('p_1')],
    [
      'Throw_invoice-approval_2_t_0',
      () => makeThrowEventId('invoice-approval_2_t_0'),
    ],
    ['EventSubProcess_p_1', () => makeEventSubProcessId('p_1')],
    [
      'EventSubProcess_invoice-approval_0',
      () => makeEventSubProcessId('invoice-approval_0'),
    ],
    ['Catch_p_2', () => makeIntermediateCatchEventId('p_2')],
    [
      'Catch_invoice-approval_1_c_0',
      () => makeIntermediateCatchEventId('invoice-approval_1_c_0'),
    ],
    [
      'Boundary_Pack_error',
      () => makeBoundaryEventId('Pack', 'error', new Set()),
    ],
    [
      'Boundary_Review_timer',
      () => makeBoundaryEventId('Review', 'timer', new Set()),
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
    // An authored name matching a synthesized id is refused, from a pattern
    // list the validator spells itself. Its package cannot import these
    // templates, so this row is what keeps the two lists the same set.
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

  it('the positional throw/handler/catch templates take no taken set (no collision resolution)', () => {
    // The coordinate is unique by position, so these templates are pure
    // functions of it and need no collision resolution.
    expect(makeThrowEventId).toHaveLength(1);
    expect(makeEventSubProcessId).toHaveLength(1);
    expect(makeIntermediateCatchEventId).toHaveLength(1);
  });

  it('is host-derived, not positional: it takes a taken set and adds its result', () => {
    const taken = new Set<string>();
    const id = makeBoundaryEventId('Pack', 'error', taken);
    expect(taken.has(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Names for what the script cannot spell
// ---------------------------------------------------------------------------

describe('mintPrintableName', () => {
  // Revert: drop the leading underscore for a keyword and `user` mints itself.
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

// ---------------------------------------------------------------------------
// Collision resolver
// ---------------------------------------------------------------------------

describe('resolveCollision', () => {
  // The _2/_3 increments themselves are proven through a real caller by the
  // `makeSequenceFlowId` block below.
  it.each([
    ['A', ['B', 'C'], 'A'],
    ['X', ['X', 'X_2', 'X_3', 'X_4'], 'X_5'],
  ] as const)('%s against %j resolves to %s', (base, taken, expected) => {
    expect(resolveCollision(base, new Set(taken))).toBe(expected);
  });

  it('does not mutate the taken set', () => {
    const taken = new Set(['A']);
    resolveCollision('A', taken);
    expect(taken.size).toBe(1);
    expect(taken.has('A')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plain sequence-flow convention (regression guard for the collision rule)
// ---------------------------------------------------------------------------

describe('makeSequenceFlowId: plain sequence-flow convention', () => {
  it('first occurrence: Flow_<src>_<tgt>', () => {
    const taken = new Set<string>();
    expect(makeSequenceFlowId('ReviewInvoice', 'AmountCheck', taken)).toBe(
      'Flow_ReviewInvoice_AmountCheck',
    );
  });

  it('adds id to taken set so subsequent callers see it', () => {
    const taken = new Set<string>();
    makeSequenceFlowId('A', 'B', taken);
    expect(taken.has('Flow_A_B')).toBe(true);
  });

  it('second occurrence of same pair: Flow_<src>_<tgt>_2', () => {
    const taken = new Set(['Flow_A_B']);
    expect(makeSequenceFlowId('A', 'B', taken)).toBe('Flow_A_B_2');
  });

  it('third occurrence of same pair: Flow_<src>_<tgt>_3', () => {
    const taken = new Set(['Flow_A_B', 'Flow_A_B_2']);
    expect(makeSequenceFlowId('A', 'B', taken)).toBe('Flow_A_B_3');
  });

  it('different pairs do not collide with each other', () => {
    const taken = new Set<string>();
    const id1 = makeSequenceFlowId('A', 'B', taken);
    const id2 = makeSequenceFlowId('A', 'C', taken);
    const id3 = makeSequenceFlowId('D', 'B', taken);
    expect(id1).toBe('Flow_A_B');
    expect(id2).toBe('Flow_A_C');
    expect(id3).toBe('Flow_D_B');
  });

  it('applies the collision rule to sequential duplicates', () => {
    // addFlow repeats the same source/target pair when a node has parallel
    // edges to the same successor.
    const taken = new Set<string>();
    const id1 = makeSequenceFlowId('A', 'B', taken);
    const id2 = makeSequenceFlowId('A', 'B', taken);
    const id3 = makeSequenceFlowId('A', 'B', taken);
    expect(id1).toBe('Flow_A_B');
    expect(id2).toBe('Flow_A_B_2');
    expect(id3).toBe('Flow_A_B_3');
  });
});
