/**
 * Compile-time and runtime tests for the `FlowElement` discriminated union.
 *
 * These tests verify that:
 *   1. A `ParallelGateway` literal is assignable to `FlowElement`.
 *   2. A `switch (fe.kind)` over `FlowElement` that includes a
 *      `'parallelGateway'` arm type-checks — i.e. TypeScript accepts the
 *      exhaustive helper without a compile error, which would only happen if
 *      `'parallelGateway'` is a valid discriminant in the union.
 *
 * The tests are deliberately free of trivial field-presence assertions
 * (we don't test "ParallelGateway has an `id` field") — those are obvious
 * from the interface definition and add no value.
 */

import { describe, it, expect } from 'vitest';
import type { FlowElement, ParallelGateway } from '../../src/ir/types.js';

/**
 * Exhaustive switch helper over `FlowElement`.
 *
 * The helper returns a string tag for each variant. If the switch is
 * non-exhaustive at the TypeScript level the `default` arm would receive a
 * `never` value and `JSON.stringify(exhaustive)` would indicate which variant
 * is unhandled. This double-duty:
 *   - Compile-time: adding a new union member without a matching arm makes the
 *     assignment `const _: never = fe` a type error, catching the regression
 *     immediately.
 *   - Runtime: Vitest exercises all arms so the helper is not dead code.
 */
function describeFlowElement(fe: FlowElement): string {
  switch (fe.kind) {
    case 'startEvent':
      return 'start';
    case 'endEvent':
      return 'end';
    case 'userTask':
      return 'user';
    case 'serviceTask':
      return 'service';
    case 'exclusiveGateway':
      return 'xor';
    case 'parallelGateway':
      return 'parallel';
    default: {
      // Exhaustiveness check: if TypeScript infers `fe` as `never` here,
      // every union variant is handled. A compile error on the line below
      // means a new variant was added without a matching arm above.
      const _: never = fe;
      throw new Error(`Unhandled FlowElement kind: ${JSON.stringify(_)}`);
    }
  }
}

describe('FlowElement — ParallelGateway union member', () => {
  it('ParallelGateway literal is assignable to FlowElement', () => {
    // This assignment is the primary compile-time test: if ParallelGateway is
    // not part of the FlowElement union, TypeScript rejects the assignment.
    const gw: FlowElement = {
      kind: 'parallelGateway',
      id: 'Gw_1',
    } satisfies ParallelGateway;

    expect(gw.kind).toBe('parallelGateway');
    expect(gw.id).toBe('Gw_1');
  });

  it('optional name field is accepted on ParallelGateway', () => {
    const gw: FlowElement = {
      kind: 'parallelGateway',
      id: 'Gw_2',
      name: 'Parallel split',
    } satisfies ParallelGateway;

    expect(gw.kind).toBe('parallelGateway');
  });

  it('exhaustive switch includes a parallelGateway arm (compile-time + runtime)', () => {
    const gw: FlowElement = { kind: 'parallelGateway', id: 'Gw_3' };
    // If the switch in `describeFlowElement` were missing the 'parallelGateway'
    // arm, TypeScript would raise a compile error at the `never` assignment.
    expect(describeFlowElement(gw)).toBe('parallel');
  });

  it('exhaustive switch still handles all other variants correctly', () => {
    expect(describeFlowElement({ kind: 'startEvent', id: 'Start_1' })).toBe(
      'start',
    );
    expect(describeFlowElement({ kind: 'endEvent', id: 'End_1' })).toBe('end');
    expect(
      describeFlowElement({
        kind: 'userTask',
        id: 'Task_1',
      }),
    ).toBe('user');
    expect(
      describeFlowElement({
        kind: 'serviceTask',
        id: 'Task_2',
        javaClass: 'com.example.Delegate',
      }),
    ).toBe('service');
    expect(
      describeFlowElement({ kind: 'exclusiveGateway', id: 'Gw_xor' }),
    ).toBe('xor');
  });
});
