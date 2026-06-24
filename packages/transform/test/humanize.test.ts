/**
 * Unit tests for {@link humanize} — the id → human-readable BPMN `name`
 * derivation. The table doubles as the contract: the IR → XML serializer
 * derives a `name` with this function, and the XML → IR importer drops any
 * `name` equal to it, so the exact mapping must stay stable.
 */
import { describe, expect, it } from 'vitest';

import { humanize } from '../src/humanize.js';

describe('humanize', () => {
  it.each([
    ['invoice-approval', 'Invoice Approval'],
    ['parallel-approval', 'Parallel Approval'],
    ['structured-control-flow', 'Structured Control Flow'],
    ['ReviewInvoice', 'Review Invoice'],
    ['SeniorApproval', 'Senior Approval'],
    ['AutoApprove', 'Auto Approve'],
    ['ApproveA', 'Approve A'],
    ['AuditLog', 'Audit Log'],
    ['Done', 'Done'],
    ['review_invoice', 'Review Invoice'],
    ['HTTPRequest', 'HTTP Request'],
  ])('humanize(%j) === %j', (id, expected) => {
    expect(humanize(id)).toBe(expected);
  });
});
