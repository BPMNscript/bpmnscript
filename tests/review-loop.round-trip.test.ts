// A `do ... while` whose body splits on every route, one route leaving the
// loop. The pin below catches the printer hoisting the staying route out of
// the loop, which the IR comparison would only report as a lost edge.

import { describe, it, expect } from 'vitest';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('review-loop', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('prints the split inside the loop body, the leaving route as a jump and the staying route inline', () => {
    expect(rt.dslPrime).toContain(
      [
        '  do {',
        '    user ApproveInvoice(assignee: "demo")',
        '    if (approved) {',
        '      goto PrepareBankTransfer',
        '    } else if (!approved) {',
        '      call ReviewInvoice(process: "ReviewInvoice") {',
        '        in invoiceDocument',
        '        out clarified',
        '      }',
        '    }',
        '  } while (clarified)',
        '',
      ].join('\n'),
    );
  });
});
