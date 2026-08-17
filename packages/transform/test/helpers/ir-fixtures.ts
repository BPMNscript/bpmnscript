import type { BpmnProcess } from '../../src/ir/types.js';

/**
 * The IR `xmlToIr` produces from `tests/golden/invoice-approval-handwritten.bpmn`,
 * with the handwritten ids preserved verbatim on import.
 *
 * The start event (ReviewStart) and end event (Done) have no `name` because the
 * handwritten BPMN gives them no `name` attribute, and the gateway has no
 * synthesized join: both branches converge directly on `Done`. The process
 * `name` is absent for the same reason — "Invoice Approval" is exactly
 * `humanize("invoice-approval")`, so import treats it as derivable and drops
 * it. Fixtures that need the name back spread it in:
 * `{ ...HANDWRITTEN_IMPORT_IR, name: 'Invoice Approval' }`.
 */
export const HANDWRITTEN_IMPORT_IR: BpmnProcess = {
  id: 'invoice-approval',
  isExecutable: true,
  flowElements: [
    { kind: 'startEvent', id: 'ReviewStart' },
    {
      kind: 'userTask',
      id: 'ReviewInvoice',
      name: 'Review invoice',
      assignee: 'demo',
    },
    {
      kind: 'exclusiveGateway',
      id: 'AmountCheck',
      name: 'Amount > 1000?',
      defaultFlowId: 'AutoApprovePath',
    },
    {
      kind: 'userTask',
      id: 'SeniorApproval',
      name: 'Senior approval',
      assignee: 'manager',
    },
    {
      kind: 'serviceTask',
      id: 'AutoApprove',
      name: 'Auto-approve',
      binding: {
        kind: 'class',
        className: 'com.example.invoice.AutoApproveDelegate',
      },
    },
    { kind: 'endEvent', id: 'Done' },
  ],
  sequenceFlows: [
    {
      id: 'Flow_ReviewStart_ReviewInvoice',
      sourceRef: 'ReviewStart',
      targetRef: 'ReviewInvoice',
    },
    {
      id: 'Flow_ReviewInvoice_AmountCheck',
      sourceRef: 'ReviewInvoice',
      targetRef: 'AmountCheck',
    },
    {
      id: 'Flow_SeniorBranch',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
      conditionExpression: '${amount > 1000}',
    },
    {
      id: 'AutoApprovePath',
      sourceRef: 'AmountCheck',
      targetRef: 'AutoApprove',
    },
    {
      id: 'Flow_SeniorApproval_Done',
      sourceRef: 'SeniorApproval',
      targetRef: 'Done',
    },
    {
      id: 'Flow_AutoApprove_Done',
      sourceRef: 'AutoApprove',
      targetRef: 'Done',
    },
  ],
};
