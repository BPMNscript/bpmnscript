/**
 * Compile-time guards for the IR discriminated unions.
 * Each helper below switches over every member of a union and assigns the
 * scrutinee to `const _: never` in the default branch, so adding a union member
 * without a matching arm is a compile error. The tests drive each helper over
 * every arm, which keeps the runtime side honest too.
 */

import { describe, it, expect } from 'vitest';
import type {
  EventDefinition,
  FlowElement,
  ServiceTaskBinding,
} from '../../src/ir/types.js';

/**
 * Exhaustive switch helper over `FlowElement`. Adding a union member without a
 * matching arm makes the `const _: never = fe` assignment in the default branch
 * a compile error.
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
    case 'intermediateThrowEvent':
      return 'intermediateThrow';
    default: {
      const _: never = fe;
      throw new Error(`Unhandled FlowElement kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Exhaustive switch helper over `ServiceTaskBinding`, mirroring
 * `describeFlowElement`.
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

/**
 * Exhaustive switch helper over `EventDefinition`, mirroring
 * `describeFlowElement`.
 */
function describeDefinition(def: EventDefinition): string {
  switch (def.kind) {
    case 'error':
      return 'error';
    case 'escalation':
      return 'escalation';
    case 'compensation':
      return 'compensation';
    case 'message':
      return `message:${def.messageName}`;
    case 'signal':
      return `signal:${def.signalName}`;
    case 'timer':
      return `timer:${def.timerKind}:${def.expression}`;
    case 'conditional':
      return `conditional:${def.condition}`;
    default: {
      const _: never = def;
      throw new Error(`Unhandled EventDefinition kind: ${JSON.stringify(_)}`);
    }
  }
}

describe('IR discriminated unions — exhaustive switch guards', () => {
  it('the exhaustive switch handles every FlowElement variant', () => {
    expect(describeFlowElement({ kind: 'startEvent', id: 'Start_1' })).toBe(
      'start',
    );
    expect(describeFlowElement({ kind: 'endEvent', id: 'End_1' })).toBe('end');
    expect(describeFlowElement({ kind: 'userTask', id: 'Task_1' })).toBe(
      'user',
    );
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
    expect(describeFlowElement({ kind: 'parallelGateway', id: 'Gw_3' })).toBe(
      'parallel',
    );
    expect(
      describeFlowElement({
        kind: 'subProcess',
        id: 'S',
        flowElements: [],
        sequenceFlows: [],
      }),
    ).toBe('subProcess');
    expect(
      describeFlowElement({
        kind: 'callActivity',
        id: 'Call_2',
        calledElement: 'p',
      }),
    ).toBe('callActivity');
    expect(
      describeFlowElement({
        kind: 'intermediateThrowEvent',
        id: 'T',
        eventDefinition: { kind: 'escalation', escalationCode: 'X' },
      }),
    ).toBe('intermediateThrow');
  });

  it('the exhaustive switch handles every ServiceTaskBinding variant', () => {
    expect(
      describeBinding({ kind: 'class', className: 'com.example.Delegate' }),
    ).toBe('class:com.example.Delegate');
    expect(
      describeBinding({
        kind: 'expression',
        expression: '${bean.method(execution)}',
      }),
    ).toBe('expression:${bean.method(execution)}');
    expect(
      describeBinding({
        kind: 'delegateExpression',
        expression: '${beanName}',
      }),
    ).toBe('delegateExpression:${beanName}');
    expect(describeBinding({ kind: 'external', topic: 'shipping' })).toBe(
      'external:shipping',
    );
  });

  it('the exhaustive switch handles every EventDefinition variant', () => {
    expect(describeDefinition({ kind: 'error', errorCode: 'PF' })).toBe(
      'error',
    );
    expect(
      describeDefinition({ kind: 'escalation', escalationCode: 'LS' }),
    ).toBe('escalation');
    expect(describeDefinition({ kind: 'compensation' })).toBe('compensation');
    expect(
      describeDefinition({ kind: 'message', messageName: 'PaymentReceived' }),
    ).toBe('message:PaymentReceived');
    expect(
      describeDefinition({ kind: 'signal', signalName: 'Cancelled' }),
    ).toBe('signal:Cancelled');
    expect(
      describeDefinition({
        kind: 'timer',
        timerKind: 'duration',
        expression: 'PT1H',
      }),
    ).toBe('timer:duration:PT1H');
    expect(
      describeDefinition({ kind: 'conditional', condition: '${amount > 100}' }),
    ).toBe('conditional:${amount > 100}');
  });
});
