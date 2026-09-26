import { describe, it, expect } from 'vitest';
import { carriesFields, eventIdentities } from '../../src/ir/types.js';
import type {
  ServiceTaskBinding,
  IoValue,
  ListenerBinding,
  EngineAttributes,
  ExclusiveGateway,
} from '../../src/ir/types.js';
import {
  builtinBinding,
  classBinding,
  delegateBinding,
  exprBinding,
  externalBinding,
  minimalProcess,
  scriptValue,
  serviceTask,
} from '../helpers/ir-fixtures.js';

describe('IR types', () => {
  it('carriesFields is true for class, delegateExpression and builtin only', () => {
    const table: [string, ServiceTaskBinding | ListenerBinding][] = [
      ['class', classBinding('com.example.Delegate')],
      ['expression', exprBinding('${x}')],
      ['delegateExpression', delegateBinding('${bean}')],
      ['external', externalBinding('shipping')],
      ['decision', { kind: 'decision', decisionRef: 'riskRating' }],
      ['builtin', builtinBinding('mail')],
      ['script', scriptValue('groovy', 'return 1')],
    ];
    expect(
      table.map(([kind, binding]) => [kind, carriesFields(binding)]),
    ).toEqual([
      ['class', true],
      ['expression', false],
      ['delegateExpression', true],
      ['external', false],
      ['decision', false],
      ['builtin', true],
      ['script', false],
    ]);
  });

  it('eventIdentities counts each external mapping code in order, and none for a class binding', () => {
    const mapped = serviceTask('T', {
      kind: 'external',
      topic: 'charge-card',
      errorMappings: [
        { errorCode: 'DECLINED', condition: '${x}' },
        { errorCode: 'TIMEOUT', condition: '${y}' },
      ],
    });
    expect([...eventIdentities(minimalProcess([mapped])).errorCodes]).toEqual([
      'DECLINED',
      'TIMEOUT',
    ]);
    const classBound = serviceTask('T2', classBinding('com.example.X'));
    expect([
      ...eventIdentities(minimalProcess([classBound])).errorCodes,
    ]).toEqual([]);
  });
});

// Compile-time only: each @ts-expect-error fails `tsc -b` once the constraint it names stops holding.
const GATEWAY_WITH_IO_MAPPED: ExclusiveGateway = {
  kind: 'exclusiveGateway',
  id: 'Gw_xor2',
  // @ts-expect-error a gateway carries JobSettings but no IoMapped
  inputParameters: [],
};

// @ts-expect-error the engine default (true) is represented by omitting the field
const EXCLUSIVE_AT_DEFAULT: EngineAttributes = { exclusive: true };

const IO_VALUE_WITH_TWO_FORMS: IoValue = {
  kind: 'text',
  text: 'hi',
  // @ts-expect-error the value forms are mutually exclusive
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

export {
  GATEWAY_WITH_IO_MAPPED,
  EXCLUSIVE_AT_DEFAULT,
  IO_VALUE_WITH_TWO_FORMS,
  LISTENER_BINDING_WITH_NONE,
  LISTENER_BINDING_WITH_TWO,
};
