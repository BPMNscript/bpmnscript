// The Operaton invoice example (pool, lanes, data store, unreferenced message,
// approve/review loop whose inner split names no default) imports with
// warnings, which `describeImportFirst` refuses, so this runs by hand.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, astToIr, irToDsl, irToXml } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import { parseToAst, validate } from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/invoice-receipt.bpmn'),
  'utf-8',
);

const PRINTED = [
  'process invoice(label: "Invoice Receipt", versionTag: "V2.0", historyTimeToLive: "45") {',
  '  var approved: any',
  '  var clarified: any',
  '  start StartEvent_1(label: "Invoice\\nreceived")',
  '  decide assignApprover(label: "Assign Approver Group", decision: "invoice-assign-approver", mapDecisionResult: collectEntries, resultVariable: "approverGroups")',
  '  do {',
  '    user approveInvoice(documentation: "Approve the invoice (or not).", formKey: "embedded:app:forms/approve-invoice.html", candidateGroups: "${approverGroups}", dueDate: "${dateTime().plusWeeks(1).toDate()}") {',
  '      on create ```javascript',
  "if(!!task.getVariable('approver')) {",
  '  task.setAssignee(approver);',
  '}```',
  '      on assignment ```javascript',
  "task.setVariable('approver', task.getAssignee());```",
  '    }',
  '    if (approved) {',
  '      goto prepareBankTransfer',
  '    } else if (!approved) {',
  '      call reviewInvoice(process: "ReviewInvoice") {',
  '        in invoiceDocument',
  '        in creditor',
  '        in amount',
  '        in invoiceCategory',
  '        in invoiceNumber',
  '        out clarified',
  '      }',
  '    }',
  '  } while (clarified)',
  '  end invoiceNotProcessed(label: "Invoice not\\nprocessed")',
  '  user prepareBankTransfer(label: "Prepare\\nBank\\nTransfer", documentation: "Prepare the bank transfer.", formKey: "embedded:app:forms/prepare-bank-transfer.html", candidateGroups: "accounting", dueDate: "${dateTime().plusWeeks(1).toDate()}")',
  '  service ServiceTask_1(label: "Archive Invoice", class: "org.operaton.bpm.example.invoice.service.ArchiveInvoiceService", asyncBefore: true)',
  '  end invoiceProcessed(label: "Invoice\\nprocessed")',
  '}',
  '',
].join('\n');

const categories = (ws: { elementId?: string; category: string }[]) =>
  ws.map((w) => ({ elementId: w.elementId, category: w.category }));

describe('the Operaton invoice example', () => {
  it('imports with the pool, lane and dropped-extra warnings, prints one clean structured script, and re-desugars to the same reachability', async () => {
    const { ir: imported, warnings: importWarnings } = await xmlToIr(FIXTURE);
    expect(categories(importWarnings)).toEqual([
      { elementId: 'Accountant', category: 'lane' },
      { elementId: 'teamAssistant', category: 'lane' },
      { elementId: 'Approver', category: 'lane' },
      { elementId: 'DataStoreReference_1', category: 'unmappedConstruct' },
      { elementId: 'prepareBankTransfer', category: 'unmappedConstruct' },
      { elementId: 'prepareBankTransfer', category: 'unmappedConstruct' },
      { elementId: 'StartEvent_1', category: 'extensionAttribute' },
      { elementId: 'ServiceTask_1', category: 'unmappedConstruct' },
      { elementId: 'reviewSuccessful', category: 'label' },
      { elementId: 'reviewNotSuccessful', category: 'label' },
      { elementId: 'invoiceApproved', category: 'label' },
      { elementId: 'invoiceNotApproved', category: 'label' },
      { elementId: 'Process_Engine_1', category: 'unmappedConstruct' },
      { elementId: 'foxMessage_en', category: 'unreferencedRoot' },
      { elementId: 'FinancialAccountingSystem', category: 'unmappedConstruct' },
    ]);

    const { source: dsl, warnings: printWarnings } = irToDsl(imported);
    expect(dsl).toEqual(PRINTED);
    expect(categories(printWarnings)).toEqual([
      { elementId: 'invoice_approved', category: 'label' },
      { elementId: 'reviewSuccessful_gw', category: 'label' },
      { elementId: 'invoice_approved', category: 'defaultFlow' },
      { elementId: 'reviewSuccessful_gw', category: 'droppedCondition' },
    ]);
    expect((await validate(dsl)).diagnostics).toEqual([]);

    // `invoice_approved` names no default, so the printed else-less chain
    // falls through to the loop gateway on recompile, which gains
    // `approveInvoice` every pair that gateway reaches.
    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      [
        ...realNodeReachability(imported),
        'approveInvoice->approveInvoice',
        'approveInvoice->invoiceNotProcessed',
      ].sort(),
    );
    expect((await xmlToIr(await irToXml(reDesugared))).warnings).toEqual([]);
  });
});
