import { it, expect } from 'vitest';

import { allOf } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('multiple-starts', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

it('every start keeps its trigger at every hop, and none takes an incoming flow', () => {
  for (const [label, ir] of rt.hops) {
    const starts = allOf(ir, 'startEvent')
      .map((s) => [s.id, s.eventDefinition] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(starts, `start set differs in ${label}`).toEqual([
      ['FromDesk', undefined],
      ['FromPartner', { kind: 'message', messageName: 'PartnerOrderReceived' }],
      ['FromShop', { kind: 'message', messageName: 'OrderPlaced' }],
      ['FromWarehouse', { kind: 'signal', signalName: 'StockCounted' }],
    ]);

    const startIds = new Set(starts.map(([id]) => id));
    expect(
      ir.sequenceFlows.filter((flow) => startIds.has(flow.targetRef)),
      `a sequence flow targets a start in ${label}`,
    ).toEqual([]);
  }
});
