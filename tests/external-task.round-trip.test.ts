// Each topic-bound kind carries a different subset of the extras
// `parseExternalServiceTask` reads.

import { it, expect } from 'vitest';

import type { ServiceTaskBinding } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { bindingOf } from './helpers/ir-query.js';

const rt = roundTripFixture('external-task', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

const EXTERNAL_BINDINGS: Record<string, ServiceTaskBinding> = {
  ChargeCard: {
    kind: 'external',
    topic: 'charge-card',
    taskPriority: '42',
    properties: [
      { key: 'gateway', value: 'stripe' },
      { key: 'attempts', value: '3' },
    ],
    errorMappings: [
      {
        errorCode: 'PAYMENT_DECLINED',
        condition: '${externalTask.errorMessage == "declined"}',
      },
      { errorCode: 'GATEWAY_DOWN', condition: '${externalTask.retries == 0}' },
    ],
  },
  SendReceipt: {
    kind: 'external',
    topic: 'send-receipt',
    taskPriority: '${amount > 1000 ? 90 : 10}',
    properties: [{ key: 'channel', value: 'email' }],
  },
  RateFraud: {
    kind: 'external',
    topic: 'rate-fraud',
    errorMappings: [
      {
        errorCode: 'PAYMENT_DECLINED',
        condition: '${externalTask.errorDetails == "fraud"}',
      },
    ],
  },
};

it('keeps every extra on all three task kinds at each hop and through import, written on their tags', () => {
  for (const [label, ir] of [
    ...rt.hops,
    ['imported', rt.irFromImport],
  ] as const) {
    for (const [id, binding] of Object.entries(EXTERNAL_BINDINGS)) {
      expect(bindingOf(ir, id), `${id} in ${label}`).toStrictEqual(binding);
    }
  }
  for (const written of [
    'operaton:type="external" operaton:topic="charge-card" operaton:taskPriority="42"',
    '<operaton:properties>\n' +
      '          <operaton:property name="gateway" value="stripe" />\n' +
      '          <operaton:property name="attempts" value="3" />\n' +
      '        </operaton:properties>',
    '<operaton:errorEventDefinition errorRef="Error_PAYMENT_DECLINED" ' +
      'expression="${externalTask.errorMessage == &#34;declined&#34;}" />\n' +
      '        <operaton:errorEventDefinition errorRef="Error_GATEWAY_DOWN" ' +
      'expression="${externalTask.retries == 0}" />',
    'operaton:taskPriority="${amount &#62; 1000 ? 90 : 10}"',
  ]) {
    expect(rt.frozenXml).toContain(written);
  }
  expect(
    [...rt.frozenXml.matchAll(/<bpmn:error id="[^"]+" name="([^"]+)"/g)].map(
      (m) => m[1],
    ),
  ).toEqual(['PAYMENT_DECLINED', 'GATEWAY_DOWN']);
});
