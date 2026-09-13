// The three topic-bound kinds each carry a different subset of the extras
// `parseExternalServiceTask` reads, so a priority, property or mapping that
// stops travelling on one tag, or one that appears from nowhere, fails the
// whole-object comparison below.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess, ServiceTask } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { describeDiContainment } from './helpers/di-bounds.js';
import { elementById, theOnly } from './helpers/ir-query.js';

// `ServiceTaskBinding` itself is not a public export; derived here from the
// exported `ServiceTask` carrier instead of widening the package's surface.
type ServiceTaskBinding = ServiceTask['binding'];

function bindingOf(container: BpmnProcess, id: string): ServiceTaskBinding {
  const el = elementById(container, id);
  if (el.kind !== 'serviceTask') {
    throw new Error(`expected '${id}' to be a service task, found ${el.kind}`);
  }
  return el.binding;
}

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

describe('the frozen external-task binding contract', () => {
  it('every extra survives at each hop and through import, on all three task kinds', () => {
    const runs: (readonly [label: string, ir: BpmnProcess])[] = [
      ...rt.hops,
      ['imported', rt.irFromImport],
    ];
    for (const [label, ir] of runs) {
      for (const id of Object.keys(EXTERNAL_BINDINGS)) {
        expect(
          bindingOf(ir, id),
          `${id}.binding differs in ${label}`,
        ).toStrictEqual(EXTERNAL_BINDINGS[id]);
      }
    }
  });

  it('the frozen artifact writes the priority, properties and error mappings on their tags', () => {
    expect(rt.frozenXml).toContain(
      'operaton:type="external" operaton:topic="charge-card" operaton:taskPriority="42"',
    );
    expect(rt.frozenXml).toContain(
      '<operaton:properties>\n' +
        '          <operaton:property name="gateway" value="stripe" />\n' +
        '          <operaton:property name="attempts" value="3" />\n' +
        '        </operaton:properties>',
    );
    expect(rt.frozenXml).toContain(
      '<operaton:errorEventDefinition errorRef="Error_PAYMENT_DECLINED" ' +
        'expression="${externalTask.errorMessage == &#34;declined&#34;}" />\n' +
        '        <operaton:errorEventDefinition errorRef="Error_GATEWAY_DOWN" ' +
        'expression="${externalTask.retries == 0}" />',
    );
    expect(rt.frozenXml).toContain(
      'operaton:taskPriority="${amount &#62; 1000 ? 90 : 10}"',
    );
  });

  it('the frozen artifact carries the two error roots in first-use order', () => {
    const roots = [
      ...rt.frozenXml.matchAll(/<bpmn:error id="[^"]+" name="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(roots).toEqual(['PAYMENT_DECLINED', 'GATEWAY_DOWN']);
  });
});

// The process-wide `on error(GATEWAY_DOWN)` handler lowers to a
// `triggeredByEvent` sub-process with a synthesized id, so it is located by
// what it is rather than by a name written in the fixture.
describeDiContainment(rt, () => [
  theOnly(rt.ir1, 'subProcess', (sp) => sp.triggeredByEvent === true).id,
]);
