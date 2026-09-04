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
  IoValue,
  ListenerBinding,
  EngineAttributes,
  BpmnProcess,
  StartEvent,
  EndEvent,
  IntermediateThrowEvent,
  IntermediateCatchEvent,
  BoundaryEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  Task,
  ReceiveTask,
  SubProcess,
  CallActivity,
  ExclusiveGateway,
} from '../../src/ir/types.js';
import {
  boundaryEvent,
  callActivity,
  classBinding,
  conditionDef,
  delegateBinding,
  errorDef,
  escalationDef,
  exprBinding,
  externalBinding,
  gateway,
  ioParam,
  listValue,
  mapEntry,
  mapValue,
  messageDef,
  scriptTask,
  scriptValue,
  serviceTask,
  signalDef,
  textValue,
  timerDef,
  typedEvent,
} from '../helpers/ir-fixtures.js';

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
    case 'task':
      return 'task';
    case 'receiveTask':
      return 'receive';
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
    case 'intermediateCatchEvent':
      return 'intermediateCatch';
    case 'boundaryEvent':
      return 'boundary';
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
    case 'decision':
      return `decision:${binding.decisionRef}`;
    default: {
      const _: never = binding;
      throw new Error(`Unhandled binding kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Exhaustive switch helper over `IoValue`, mirroring `describeFlowElement`.
 * Recurses into `list`/`map` so a nested shape (a list of maps, a map entry
 * holding a list) round-trips through the helper too.
 */
function describeIoValue(value: IoValue): string {
  switch (value.kind) {
    case 'text':
      return `text:${value.text}`;
    case 'script':
      return `script:${value.format}:${value.code}`;
    case 'list':
      return `list:[${value.items.map(describeIoValue).join(',')}]`;
    case 'map':
      return `map:{${value.entries.map((e) => `${e.key}=${describeIoValue(e.value)}`).join(',')}}`;
    default: {
      const _: never = value;
      throw new Error(`Unhandled IoValue kind: ${JSON.stringify(_)}`);
    }
  }
}

/**
 * Exhaustive switch helper over `ListenerBinding`, mirroring
 * `describeBinding`.
 */
function describeListenerBinding(binding: ListenerBinding): string {
  switch (binding.kind) {
    case 'class':
      return `class:${binding.className}`;
    case 'expression':
      return `expression:${binding.expression}`;
    case 'delegateExpression':
      return `delegateExpression:${binding.expression}`;
    case 'script':
      return `script:${binding.format}:${binding.code}`;
    default: {
      const _: never = binding;
      throw new Error(`Unhandled ListenerBinding kind: ${JSON.stringify(_)}`);
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
    case 'terminate':
      return 'terminate';
    case 'cancel':
      return 'cancel';
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

describe('IR discriminated unions: exhaustive switch guards', () => {
  it('the exhaustive switch handles every FlowElement variant', () => {
    expect(describeFlowElement({ kind: 'startEvent', id: 'Start_1' })).toBe(
      'start',
    );
    expect(describeFlowElement({ kind: 'endEvent', id: 'End_1' })).toBe('end');
    expect(describeFlowElement({ kind: 'userTask', id: 'Task_1' })).toBe(
      'user',
    );
    expect(
      describeFlowElement(
        serviceTask('Task_2', classBinding('com.example.Delegate')),
      ),
    ).toBe('service');
    expect(
      describeFlowElement(scriptTask('Task_3', 'javascript', 'x = 1;')),
    ).toBe('script');
    expect(describeFlowElement({ kind: 'task', id: 'Task_4' })).toBe('task');
    expect(describeFlowElement({ kind: 'receiveTask', id: 'Task_5' })).toBe(
      'receive',
    );
    expect(describeFlowElement(gateway('Gw_xor'))).toBe('xor');
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
    expect(describeFlowElement(callActivity('Call_2', 'p'))).toBe(
      'callActivity',
    );
    expect(
      describeFlowElement(
        typedEvent('intermediateThrowEvent', 'T', escalationDef('X')),
      ),
    ).toBe('intermediateThrow');
    expect(
      describeFlowElement(
        typedEvent('intermediateCatchEvent', 'IC', signalDef('Go')),
      ),
    ).toBe('intermediateCatch');
    expect(
      describeFlowElement(
        boundaryEvent('BD', 'Task_1', timerDef('duration', 'PT1H')),
      ),
    ).toBe('boundary');
  });

  it('the exhaustive switch handles every ServiceTaskBinding variant', () => {
    expect(describeBinding(classBinding('com.example.Delegate'))).toBe(
      'class:com.example.Delegate',
    );
    expect(describeBinding(exprBinding('${bean.method(execution)}'))).toBe(
      'expression:${bean.method(execution)}',
    );
    expect(describeBinding(delegateBinding('${beanName}'))).toBe(
      'delegateExpression:${beanName}',
    );
    expect(describeBinding(externalBinding('shipping'))).toBe(
      'external:shipping',
    );
    expect(
      describeBinding({ kind: 'decision', decisionRef: 'riskRating' }),
    ).toBe('decision:riskRating');
  });

  it('the exhaustive switch handles every EventDefinition variant', () => {
    expect(describeDefinition(errorDef('PF'))).toBe('error');
    expect(describeDefinition(escalationDef('LS'))).toBe('escalation');
    expect(describeDefinition({ kind: 'compensation' })).toBe('compensation');
    expect(describeDefinition({ kind: 'terminate' })).toBe('terminate');
    expect(describeDefinition({ kind: 'cancel' })).toBe('cancel');
    expect(describeDefinition(messageDef('PaymentReceived'))).toBe(
      'message:PaymentReceived',
    );
    expect(describeDefinition(signalDef('Cancelled'))).toBe('signal:Cancelled');
    expect(describeDefinition(timerDef('duration', 'PT1H'))).toBe(
      'timer:duration:PT1H',
    );
    expect(describeDefinition(conditionDef('${amount > 100}'))).toBe(
      'conditional:${amount > 100}',
    );
  });

  it('the exhaustive switch handles every IoValue variant, including nested list/map', () => {
    expect(describeIoValue(textValue('${amount}'))).toBe('text:${amount}');
    expect(describeIoValue(scriptValue('groovy', 'return 1'))).toBe(
      'script:groovy:return 1',
    );
    expect(
      describeIoValue(
        listValue([textValue('a'), mapValue([mapEntry('k', textValue('v'))])]),
      ),
    ).toBe('list:[text:a,map:{k=text:v}]');
    expect(
      describeIoValue(
        mapValue([mapEntry('items', listValue([textValue('x')]))]),
      ),
    ).toBe('map:{items=list:[text:x]}');
  });

  it('the exhaustive switch handles every ListenerBinding variant', () => {
    expect(describeListenerBinding(classBinding('com.example.Logger'))).toBe(
      'class:com.example.Logger',
    );
    expect(describeListenerBinding(exprBinding('${x}'))).toBe(
      'expression:${x}',
    );
    expect(describeListenerBinding(delegateBinding('${y}'))).toBe(
      'delegateExpression:${y}',
    );
    expect(describeListenerBinding(scriptValue('groovy', 'return 2'))).toBe(
      'script:groovy:return 2',
    );
  });
});

/**
 * Reused on every kind below, so one table pins the whole mixin rather than
 * one assertion per field per kind.
 */
const ENGINE_ATTRIBUTES: EngineAttributes = {
  asyncBefore: true,
  asyncAfter: true,
  exclusive: false,
  jobPriority: '${priority}',
  retryCycle: 'R3/PT10M',
  executionListeners: [
    { event: 'start', binding: classBinding('com.example.Logger') },
  ],
};

/**
 * The "who extends what" table: `EngineAttributes` reaches every event and
 * activity kind, `IoMapped` reaches every activity kind, and each kind's own
 * extra fields (`versionTag`, `resultVariable`, the user-task assignment
 * fields, `taskListeners`) sit alongside them. The tuple annotation gives each
 * literal its exact type, so a literal only compiles if every field the table
 * promises is present on that interface.
 */
const TYPE_TABLE: [
  StartEvent,
  EndEvent,
  IntermediateThrowEvent,
  IntermediateCatchEvent,
  BoundaryEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  Task,
  ReceiveTask,
  SubProcess,
  CallActivity,
  BpmnProcess,
] = [
  { kind: 'startEvent', id: 'S', ...ENGINE_ATTRIBUTES },
  { kind: 'endEvent', id: 'E', ...ENGINE_ATTRIBUTES },
  {
    kind: 'intermediateThrowEvent',
    id: 'T',
    eventDefinition: escalationDef('X'),
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'intermediateCatchEvent',
    id: 'C',
    eventDefinition: signalDef('Go'),
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'boundaryEvent',
    id: 'B',
    attachedToRef: 'Task_1',
    eventDefinition: timerDef('duration', 'PT1H'),
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'userTask',
    id: 'U',
    assignee: 'alice',
    candidateGroups: 'reviewers',
    candidateUsers: 'alice,bob',
    dueDate: '${dueDate}',
    followUpDate: '${followUpDate}',
    priority: '50',
    inputParameters: [ioParam('amount', textValue('${amount}'))],
    outputParameters: [ioParam('result', textValue('${result}'))],
    taskListeners: [
      {
        event: 'timeout',
        binding: delegateBinding('${reminder}'),
        timer: timerDef('duration', 'PT2H'),
      },
    ],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'serviceTask',
    id: 'SV',
    binding: externalBinding('ship'),
    resultVariable: 'shipped',
    inputParameters: [ioParam('x', textValue('1'))],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'scriptTask',
    id: 'SC',
    format: 'javascript',
    code: 'x = 1;',
    resultVariable: 'x',
    outputParameters: [ioParam('x', textValue('${x}'))],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'task',
    id: 'TK',
    inputParameters: [ioParam('x', textValue('1'))],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'receiveTask',
    id: 'RC',
    messageName: 'OrderPaid',
    outputParameters: [ioParam('x', textValue('${x}'))],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'subProcess',
    id: 'S1',
    flowElements: [],
    sequenceFlows: [],
    inputParameters: [ioParam('x', textValue('1'))],
    ...ENGINE_ATTRIBUTES,
  },
  {
    kind: 'callActivity',
    id: 'C1',
    calledElement: 'OtherProcess',
    inputParameters: [ioParam('x', textValue('1'))],
    ...ENGINE_ATTRIBUTES,
  },
  // A process carries versionTag, and neither mixin of its own.
  {
    id: 'P',
    isExecutable: true,
    versionTag: '1.4.0',
    flowElements: [],
    sequenceFlows: [],
  },
];

/**
 * The constraints that make an illegal combination unrepresentable: gateways
 * get neither mixin, and the two value unions (`IoValue`, `ListenerBinding`)
 * refuse a value carrying more than one form, the way `ServiceTaskBinding`
 * already does. Each literal is one TypeScript can only accept by widening or
 * dropping the extra property, and every `@ts-expect-error` below fails the
 * typecheck if the constraint it names ever stops holding.
 */
const GATEWAY_WITH_ENGINE_ATTRIBUTE: ExclusiveGateway = {
  kind: 'exclusiveGateway',
  id: 'Gw_xor',
  // @ts-expect-error a synthesized gateway carries neither EngineAttributes nor IoMapped
  asyncBefore: true,
};

// @ts-expect-error the engine default (true) is represented by omitting the field, not by storing it
const EXCLUSIVE_AT_DEFAULT: EngineAttributes = { exclusive: true };

const IO_VALUE_WITH_TWO_FORMS: IoValue = {
  kind: 'text',
  text: 'hi',
  // @ts-expect-error a text value has no `items`; the four forms are mutually exclusive
  items: [],
};

// @ts-expect-error every binding requires its `kind` and the field that kind names
const LISTENER_BINDING_WITH_NONE: ListenerBinding = {};

const LISTENER_BINDING_WITH_TWO: ListenerBinding = {
  kind: 'class',
  className: 'c',
  // @ts-expect-error a listener names exactly one binding
  expression: '${e}',
};

describe('the IR type table', () => {
  it('compiles', () => {
    // The literals above are the content: each one only type-checks if the IR
    // interfaces still carry the fields the table promises, and each
    // `@ts-expect-error` only type-checks while the constraint it names holds.
    // This keeps them referenced and confirms every one is a real value.
    for (const literal of [
      ...TYPE_TABLE,
      GATEWAY_WITH_ENGINE_ATTRIBUTE,
      EXCLUSIVE_AT_DEFAULT,
      IO_VALUE_WITH_TWO_FORMS,
      LISTENER_BINDING_WITH_NONE,
      LISTENER_BINDING_WITH_TWO,
    ]) {
      expect(literal).toBeTypeOf('object');
    }
  });
});
