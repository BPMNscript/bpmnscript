/**
 * Compile-time and runtime tests for the `FlowElement` discriminated union.
 *
 * These tests verify that:
 *   1. A `ParallelGateway` literal is assignable to `FlowElement`.
 *   2. A `switch (fe.kind)` over `FlowElement` that includes a
 *      `'parallelGateway'` arm type-checks — i.e. TypeScript accepts the
 *      exhaustive helper without a compile error, which would only happen if
 *      `'parallelGateway'` is a valid discriminant in the union.
 *   3. `ServiceTask.binding` accepts exactly one literal per variant of its
 *      discriminated union (class / expression / delegateExpression /
 *      external), and `ScriptTask` is a valid `FlowElement` member.
 *   4. `IR_TYPE_NAMES` reflects the current type shapes.
 *
 * Trivial field-presence assertions ("ParallelGateway has an `id` field")
 * are omitted — the interface definitions already pin them.
 */

import { describe, it, expect } from 'vitest';
import type {
  CallActivity,
  FlowContainer,
  FlowElement,
  ParallelGateway,
  ServiceTask,
  ServiceTaskBinding,
  ScriptTask,
  SubProcess,
} from '../../src/ir/types.js';
import { IR_TYPE_NAMES } from '../../src/index.js';

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
    case 'scriptTask':
      return 'script';
    case 'exclusiveGateway':
      return 'xor';
    case 'parallelGateway':
      return 'parallel';
    case 'subProcess':
      return 'subProcess';
    case 'callActivity':
      return 'callActivity';
    default: {
      // Exhaustiveness check: if TypeScript infers `fe` as `never` here,
      // every union variant is handled. A compile error on the line below
      // means a new variant was added without a matching arm above.
      const _: never = fe;
      throw new Error(`Unhandled FlowElement kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Exhaustive switch helper over `ServiceTaskBinding`, mirroring
 * `describeFlowElement`: a missing arm makes the `never` assignment a
 * compile error, so adding a binding kind without updating a consumer's
 * switch is caught here first.
 */
function describeBinding(binding: ServiceTaskBinding): string {
  switch (binding.kind) {
    case 'class':
      return `class:${binding.className}`;
    case 'expression':
      return `expression:${binding.expression}`;
    case 'delegateExpression':
      return `delegateExpression:${binding.expression}`;
    case 'external':
      return `external:${binding.topic}`;
    default: {
      const _: never = binding;
      throw new Error(`Unhandled binding kind: ${JSON.stringify(_)}`);
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
        binding: { kind: 'class', className: 'com.example.Delegate' },
      }),
    ).toBe('service');
    expect(
      describeFlowElement({
        kind: 'scriptTask',
        id: 'Task_3',
        format: 'javascript',
        code: 'x = 1;',
      }),
    ).toBe('script');
    expect(
      describeFlowElement({ kind: 'exclusiveGateway', id: 'Gw_xor' }),
    ).toBe('xor');
  });
});

describe('ServiceTask — binding discriminated union', () => {
  it('accepts a class binding', () => {
    const task: ServiceTask = {
      kind: 'serviceTask',
      id: 'Task_class',
      binding: { kind: 'class', className: 'com.example.Delegate' },
    };

    expect(describeBinding(task.binding)).toBe('class:com.example.Delegate');
  });

  it('accepts an expression binding', () => {
    const task: ServiceTask = {
      kind: 'serviceTask',
      id: 'Task_expr',
      binding: { kind: 'expression', expression: '${bean.method(execution)}' },
    };

    expect(describeBinding(task.binding)).toBe(
      'expression:${bean.method(execution)}',
    );
  });

  it('accepts a delegateExpression binding', () => {
    const task: ServiceTask = {
      kind: 'serviceTask',
      id: 'Task_delegate',
      binding: { kind: 'delegateExpression', expression: '${beanName}' },
    };

    expect(describeBinding(task.binding)).toBe(
      'delegateExpression:${beanName}',
    );
  });

  it('accepts an external binding', () => {
    const task: ServiceTask = {
      kind: 'serviceTask',
      id: 'Task_external',
      binding: { kind: 'external', topic: 'shipping' },
    };

    expect(describeBinding(task.binding)).toBe('external:shipping');
  });
});

describe('ScriptTask — new FlowElement kind', () => {
  it('ScriptTask literal is assignable to FlowElement', () => {
    const script: FlowElement = {
      kind: 'scriptTask',
      id: 'Script_1',
      format: 'javascript',
      code: 'execution.setVariable("x", 1);',
    } satisfies ScriptTask;

    expect(script.kind).toBe('scriptTask');
  });
});

describe('SubProcess — recursive FlowContainer union member', () => {
  it('a recursive SubProcess literal (children + flows) is assignable to FlowElement', () => {
    // The body carries its own flow elements and sequence flows; the whole
    // sub-process is itself a FlowElement. If SubProcess were not part of the
    // union, or not a FlowContainer, TypeScript would reject this assignment.
    const sub: FlowElement = {
      kind: 'subProcess',
      id: 'Handle',
      name: 'Handle order',
      flowElements: [
        { kind: 'startEvent', id: 'StartEvent_Handle' },
        { kind: 'userTask', id: 'Review', assignee: 'demo' },
        { kind: 'endEvent', id: 'EndEvent_Handle' },
      ],
      sequenceFlows: [
        {
          id: 'Flow_Start_Review',
          sourceRef: 'StartEvent_Handle',
          targetRef: 'Review',
        },
        {
          id: 'Flow_Review_End',
          sourceRef: 'Review',
          targetRef: 'EndEvent_Handle',
        },
      ],
    } satisfies SubProcess;

    expect(sub.kind).toBe('subProcess');
    // The nested body is reachable and typed as a container.
    expect(sub.kind === 'subProcess' && sub.flowElements).toHaveLength(3);
    expect(sub.kind === 'subProcess' && sub.sequenceFlows).toHaveLength(2);
  });

  it('nests a sub-process inside a sub-process (recursion holds)', () => {
    const outer: SubProcess = {
      kind: 'subProcess',
      id: 'Outer',
      flowElements: [
        {
          kind: 'subProcess',
          id: 'Inner',
          flowElements: [{ kind: 'userTask', id: 'A' }],
          sequenceFlows: [],
        },
      ],
      sequenceFlows: [],
    };

    const inner = outer.flowElements[0];
    expect(inner?.kind).toBe('subProcess');
  });

  it('SubProcess satisfies the FlowContainer shape', () => {
    const sub: SubProcess = {
      kind: 'subProcess',
      id: 'C',
      flowElements: [],
      sequenceFlows: [],
    };
    // A SubProcess is a FlowContainer: the per-container transform passes take
    // it by its container shape.
    const container: FlowContainer = sub;
    expect(container.id).toBe('C');
  });

  it('exhaustive switch includes a subProcess arm (compile-time + runtime)', () => {
    const sub: FlowElement = {
      kind: 'subProcess',
      id: 'S',
      flowElements: [],
      sequenceFlows: [],
    };
    expect(describeFlowElement(sub)).toBe('subProcess');
  });
});

describe('CallActivity — leaf FlowElement union member', () => {
  it('a full CallActivity literal (binding, businessKey, in/out mappings) is assignable to FlowElement', () => {
    // The richest shape: every optional field populated, all three mapping
    // variants present. If CallActivity were not part of the union — or a field
    // were mistyped — TypeScript would reject this assignment.
    const call: FlowElement = {
      kind: 'callActivity',
      id: 'Call_1',
      name: 'Run sub-process',
      calledElement: 'sub-process',
      binding: { kind: 'version', version: '3' },
      businessKey: '${execution.processBusinessKey}',
      inMappings: [
        { kind: 'all' },
        { kind: 'variable', source: 'amount', target: 'amount' },
        {
          kind: 'expression',
          sourceExpression: '${total * 2}',
          target: 'doubled',
          local: true,
        },
      ],
      outMappings: [
        { kind: 'variable', source: 'result', target: 'outcome' },
      ],
    } satisfies CallActivity;

    expect(call.kind).toBe('callActivity');
    // A CallActivity is a leaf: it carries no container arrays.
    expect('flowElements' in call).toBe(false);
  });

  it('a minimal CallActivity (calledElement only) is assignable', () => {
    const call: CallActivity = {
      kind: 'callActivity',
      id: 'Call_min',
      calledElement: 'other',
    };
    expect(call.calledElement).toBe('other');
  });

  it('exhaustive switch includes a callActivity arm (compile-time + runtime)', () => {
    const call: FlowElement = {
      kind: 'callActivity',
      id: 'Call_2',
      calledElement: 'p',
    };
    expect(describeFlowElement(call)).toBe('callActivity');
  });
});

describe('IR_TYPE_NAMES', () => {
  it('lists ServiceTask and ScriptTask, and no longer ServiceTaskJavaClass', () => {
    expect(IR_TYPE_NAMES).toContain('ServiceTask');
    expect(IR_TYPE_NAMES).toContain('ScriptTask');
    expect(IR_TYPE_NAMES).not.toContain('ServiceTaskJavaClass');
  });

  it('lists SubProcess and FlowContainer', () => {
    expect(IR_TYPE_NAMES).toContain('SubProcess');
    expect(IR_TYPE_NAMES).toContain('FlowContainer');
  });

  it('lists CallActivity', () => {
    expect(IR_TYPE_NAMES).toContain('CallActivity');
  });
});
