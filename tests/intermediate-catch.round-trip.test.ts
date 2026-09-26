import { it, expect } from 'vitest';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('intermediate-catch', {
  dslPrimeFrom: 'frozen',
  recompile: 'errors',
});

it('prints each catch as a bare `await` on its trigger, never the synthesized id', () => {
  expect(rt.dslPrime).toBe(
    [
      'process order-processing {',
      '  var amount: any',
      '  start OrderReceived',
      '  user ReviewOrder(label: "Review the order", assignee: "demo")',
      '  await message("PaymentConfirmed")',
      '  await timer("PT1H")',
      '  await signal("StockReplenished")',
      '  await condition(amount > 100)',
      '  service DispatchOrder(label: "Dispatch the order", class: "com.example.orders.DispatchDelegate")',
      '  end OrderDispatched',
      '}',
      '',
    ].join('\n'),
  );
});
