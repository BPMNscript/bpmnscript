import { it, expect } from 'vitest';

import { endEvent, theOnly } from './helpers/ir-query.js';
import { definitionRefOf, messageRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-positions', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

it('keeps the message start and the labelled terminate end at every hop, and writes each position back on its own statement', () => {
  for (const [label, ir] of rt.hops) {
    expect(theOnly(ir, 'startEvent').eventDefinition, label).toEqual({
      kind: 'message',
      messageName: 'OrderReceived',
    });
    const abandon = endEvent(ir, 'OrderAbandoned');
    expect([abandon.eventDefinition, abandon.name], label).toEqual([
      { kind: 'terminate' },
      'Abandon every path',
    ]);
  }
  expect(rt.dslPrime).toBe(
    [
      'process order-dispatch {',
      '  start OrderReceived message("OrderReceived", label: "An order arrives") {',
      '    form {',
      '      amount: number "Order amount"',
      '    }',
      '  }',
      '  user ConfirmOrder(label: "Confirm the order", assignee: "demo")',
      '  emit message NotifyWarehouse("WarehouseNotified", class: "com.example.orders.NotifyWarehouseDelegate")',
      '  if (amount > 1000) {',
      '    service EscalateOrder(label: "Escalate the order", class: "com.example.orders.EscalateDelegate")',
      '    end OrderAbandoned terminate(label: "Abandon every path")',
      '  } else {',
      '    service DispatchOrder(label: "Dispatch the order", class: "com.example.orders.DispatchDelegate")',
      '  }',
      '  throw message OrderAcknowledged("OrderAcknowledged", class: "com.example.orders.AcknowledgeOrderDelegate")',
      '}',
      '',
    ].join('\n'),
  );
});

it('carries one bpmn:Message per name in first-appearance order, the start referencing its root beside its form data', () => {
  const roots = messageRoots(rt.frozenXml);
  expect(roots.map((root) => root.name)).toEqual([
    'OrderReceived',
    'WarehouseNotified',
    'OrderAcknowledged',
  ]);
  expect(
    /<bpmn:startEvent id="OrderReceived"[\s\S]*?<\/bpmn:startEvent>/.exec(
      rt.frozenXml,
    )?.[0],
  ).toContain('<operaton:formData>');
  expect(definitionRefOf(rt.frozenXml, 'OrderReceived', 'message')).toBe(
    roots[0]!.id,
  );
});
