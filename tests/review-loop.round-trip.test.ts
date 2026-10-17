// A `do ... while` whose body splits on every route, one leaving the loop.

import { it, expect } from 'vitest';

import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('review-loop', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

it('prints the split inside the loop body, the leaving route as a jump and the staying route inline', () => {
  expect(rt.dslPrime).toBe(
    [
      'process invoice-review {',
      '  var approved: any',
      '  var clarified: any',
      '  start InvoiceReceived',
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
      '  end InvoiceNotProcessed(label: "Invoice not processed")',
      '  user PrepareBankTransfer(candidateGroups: "accounting")',
      '  service ArchiveInvoice(class: "org.operaton.bpm.example.invoice.service.ArchiveInvoiceService")',
      '  end InvoiceProcessed(label: "Invoice processed")',
      '}',
      '',
    ].join('\n'),
  );
});
