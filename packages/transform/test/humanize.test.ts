// irToXml derives a `name` with humanize and xmlToIr drops a `name` equal to it, so the mapping is frozen.
import { describe, expect, it } from 'vitest';

import { humanize } from '../src/humanize.js';

describe('humanize', () => {
  it.each([
    ['invoice-approval', 'Invoice Approval'],
    ['structured-control-flow', 'Structured Control Flow'],
    ['ReviewInvoice', 'Review Invoice'],
    ['ApproveA', 'Approve A'],
    ['Done', 'Done'],
    ['review_invoice', 'Review Invoice'],
    ['HTTPRequest', 'HTTP Request'],
  ])('humanize(%j) === %j', (id, expected) => {
    expect(humanize(id)).toBe(expected);
  });
});
