/**
 * Unit tests for the deterministic synthesized-id utility.
 *
 * These tests serve as both a correctness guard and as documentation for the
 * id templates. The templates are coupled to the round-trip normalizer:
 * changing a template here requires a corresponding update there.
 *
 * Templates under test (shared by the desugarer, the emitter, and the
 * round-trip normalizer):
 *
 *   Gateway_<X>_split         XOR split gateway for an `if` statement with id X
 *   Gateway_<X>_join          XOR join gateway for an `if` statement with id X
 *   Gateway_<X>_fork          AND fork (parallel) gateway for a `parallel` block X
 *   Gateway_<X>_join          AND join (parallel) gateway for a `parallel` block X
 *   Gateway_<X>_loop          XOR loop-head gateway for a `while` statement X
 *   Flow_<gatewayId>_default  Default (else-branch) flow out of a gateway
 *   Flow_<sourceId>_<targetId>  Sequence flow (plain); duplicate pairs get _2, _3, …
 *   StartEvent_<processId>    Implicit start event
 *   EndEvent_<processId>      Implicit end event; duplicates get _2, _3, …
 */

import { describe, expect, it } from 'vitest';
import {
  makeGatewaySplitId,
  makeGatewayJoinId,
  makeGatewayForkId,
  makeGatewayLoopId,
  makeDefaultFlowId,
  makeSequenceFlowId,
  makeStartEventId,
  makeEndEventId,
  resolveCollision,
} from '../src/synthesize-ids.js';

// ---------------------------------------------------------------------------
// Determinism — every constructor is called twice; results must be identical
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('makeGatewaySplitId is pure', () => {
    expect(makeGatewaySplitId('AmountCheck')).toBe(
      makeGatewaySplitId('AmountCheck'),
    );
  });

  it('makeGatewayJoinId is pure', () => {
    expect(makeGatewayJoinId('AmountCheck')).toBe(
      makeGatewayJoinId('AmountCheck'),
    );
  });

  it('makeGatewayForkId is pure', () => {
    expect(makeGatewayForkId('Step1')).toBe(makeGatewayForkId('Step1'));
  });

  it('makeGatewayLoopId is pure', () => {
    expect(makeGatewayLoopId('MyWhile')).toBe(makeGatewayLoopId('MyWhile'));
  });

  it('makeDefaultFlowId is pure', () => {
    expect(makeDefaultFlowId('Gateway_AmountCheck_split')).toBe(
      makeDefaultFlowId('Gateway_AmountCheck_split'),
    );
  });

  it('makeSequenceFlowId is pure for untaken base', () => {
    const taken = new Set<string>();
    const id1 = makeSequenceFlowId('A', 'B', taken);
    const taken2 = new Set<string>();
    const id2 = makeSequenceFlowId('A', 'B', taken2);
    expect(id1).toBe(id2);
  });

  it('makeStartEventId is deterministic for an untaken base', () => {
    const taken1 = new Set<string>();
    const taken2 = new Set<string>();
    expect(makeStartEventId('my-process', taken1)).toBe(
      makeStartEventId('my-process', taken2),
    );
  });

  it('makeStartEventId resolves a collision with an author id and records it', () => {
    // A task literally named `StartEvent_P` in process `P` collides with the
    // implicit start id; the synthesizer must suffix it deterministically.
    const taken = new Set<string>(['StartEvent_P']);
    const id = makeStartEventId('P', taken);
    expect(id).toBe('StartEvent_P_2');
    // The resolved id is recorded in `taken`.
    expect(taken.has('StartEvent_P_2')).toBe(true);
  });

  it('makeEndEventId is pure for untaken base', () => {
    const taken = new Set<string>();
    const id1 = makeEndEventId('my-process', taken);
    const taken2 = new Set<string>();
    const id2 = makeEndEventId('my-process', taken2);
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Structural stability — templates match exact documented forms
// ---------------------------------------------------------------------------

describe('structural stability', () => {
  it('makeGatewaySplitId → Gateway_<X>_split', () => {
    expect(makeGatewaySplitId('AmountCheck')).toBe('Gateway_AmountCheck_split');
    expect(makeGatewaySplitId('Step1')).toBe('Gateway_Step1_split');
  });

  it('makeGatewayJoinId → Gateway_<X>_join', () => {
    expect(makeGatewayJoinId('AmountCheck')).toBe('Gateway_AmountCheck_join');
    expect(makeGatewayJoinId('OuterIf')).toBe('Gateway_OuterIf_join');
  });

  it('makeGatewayForkId → Gateway_<X>_fork', () => {
    expect(makeGatewayForkId('Step1')).toBe('Gateway_Step1_fork');
    expect(makeGatewayForkId('ParallelBlock')).toBe(
      'Gateway_ParallelBlock_fork',
    );
  });

  it('makeGatewayLoopId → Gateway_<X>_loop', () => {
    expect(makeGatewayLoopId('MyWhile')).toBe('Gateway_MyWhile_loop');
    expect(makeGatewayLoopId('RetryLoop')).toBe('Gateway_RetryLoop_loop');
  });

  it('makeDefaultFlowId → Flow_<gatewayId>_default', () => {
    expect(makeDefaultFlowId('Gateway_AmountCheck_split')).toBe(
      'Flow_Gateway_AmountCheck_split_default',
    );
    expect(makeDefaultFlowId('Gateway_X_join')).toBe(
      'Flow_Gateway_X_join_default',
    );
  });

  it('makeStartEventId → StartEvent_<processId>', () => {
    expect(makeStartEventId('invoice-approval', new Set())).toBe(
      'StartEvent_invoice-approval',
    );
    expect(makeStartEventId('my-process', new Set())).toBe(
      'StartEvent_my-process',
    );
  });

  it('makeEndEventId (first) → EndEvent_<processId>', () => {
    const taken = new Set<string>();
    expect(makeEndEventId('invoice-approval', taken)).toBe(
      'EndEvent_invoice-approval',
    );
  });

  it('makeEndEventId (second) → EndEvent_<processId>_2', () => {
    const taken = new Set(['EndEvent_invoice-approval']);
    expect(makeEndEventId('invoice-approval', taken)).toBe(
      'EndEvent_invoice-approval_2',
    );
  });

  it('makeEndEventId (third) → EndEvent_<processId>_3', () => {
    const taken = new Set([
      'EndEvent_invoice-approval',
      'EndEvent_invoice-approval_2',
    ]);
    expect(makeEndEventId('invoice-approval', taken)).toBe(
      'EndEvent_invoice-approval_3',
    );
  });
});

// ---------------------------------------------------------------------------
// Collision resolver
// ---------------------------------------------------------------------------

describe('resolveCollision', () => {
  it('returns input unchanged when not in taken set', () => {
    expect(resolveCollision('A', new Set())).toBe('A');
    expect(resolveCollision('A', new Set(['B', 'C']))).toBe('A');
  });

  it("appends _2 when base is taken: {'A'} + 'A' → 'A_2'", () => {
    expect(resolveCollision('A', new Set(['A']))).toBe('A_2');
  });

  it("appends _3 when base and _2 are taken: {'A','A_2'} + 'A' → 'A_3'", () => {
    expect(resolveCollision('A', new Set(['A', 'A_2']))).toBe('A_3');
  });

  it('keeps incrementing until a free slot is found', () => {
    const taken = new Set(['X', 'X_2', 'X_3', 'X_4']);
    expect(resolveCollision('X', taken)).toBe('X_5');
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

describe('makeSequenceFlowId — plain sequence-flow convention', () => {
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
    // Simulate how addFlow (in ast-to-ir.ts) repeats the same source→target pair:
    //   flows = [A→B, A→B, A→B]
    //   expected: 'Flow_A_B', 'Flow_A_B_2', 'Flow_A_B_3'
    const taken = new Set<string>();
    const id1 = makeSequenceFlowId('A', 'B', taken);
    const id2 = makeSequenceFlowId('A', 'B', taken);
    const id3 = makeSequenceFlowId('A', 'B', taken);
    expect(id1).toBe('Flow_A_B');
    expect(id2).toBe('Flow_A_B_2');
    expect(id3).toBe('Flow_A_B_3');
  });
});
