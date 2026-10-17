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
import { compareModels } from './helpers/model-equivalence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
const FIXTURE = fixture('invoice-receipt.bpmn');

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
  '    } else fail',
  '  } while (clarified)',
  '  end invoiceNotProcessed(label: "Invoice not\\nprocessed")',
  '  user prepareBankTransfer(label: "Prepare\\nBank\\nTransfer", documentation: "Prepare the bank transfer.", formKey: "embedded:app:forms/prepare-bank-transfer.html", candidateGroups: "accounting", dueDate: "${dateTime().plusWeeks(1).toDate()}")',
  '  service ServiceTask_1(label: "Archive Invoice", class: "org.operaton.bpm.example.invoice.service.ArchiveInvoiceService", asyncBefore: true)',
  '  end invoiceProcessed(label: "Invoice\\nprocessed")',
  '}',
  '',
].join('\n');

const PRINTED_NO_FALLBACK = [
  'process invoice(label: "Invoice Receipt", versionTag: "V1.0", historyTimeToLive: "30") {',
  '  var approved: any',
  '  var clarified: any',
  '  start StartEvent_1(label: "Invoice\\nreceived")',
  '  decide assignApprover(label: "Assign Approver Group", decision: "invoice-assign-approver", mapDecisionResult: collectEntries, resultVariable: "approverGroups")',
  '  user approveInvoice(documentation: "Approve the invoice (or not).", formKey: "embedded:app:forms/approve-invoice.html", candidateGroups: "${approverGroups}", dueDate: "${dateTime().plusWeeks(1).toDate()}") {',
  '    on create ```javascript',
  "if(!!task.getVariable('approver')) {",
  '  task.setAssignee(approver);',
  '}```',
  '    on assignment ```javascript',
  "task.setVariable('approver', task.getAssignee());```",
  '  }',
  '  if (approved) {',
  '    service ServiceTask_06mdb3v(label: "Notify Creditor", class: "org.operaton.bpm.example.invoice.service.NotifyCreditorService")',
  '    user prepareBankTransfer(label: "Prepare\\nBank\\nTransfer", documentation: "Prepare the bank transfer.", formKey: "embedded:app:forms/prepare-bank-transfer.html", candidateGroups: "accounting", dueDate: "${dateTime().plusWeeks(1).toDate()}")',
  '    service ServiceTask_1(label: "Archive Invoice", class: "org.operaton.bpm.example.invoice.service.ArchiveInvoiceService", asyncBefore: true)',
  '    end invoiceProcessed(label: "Invoice\\nprocessed")',
  '  } else if (!approved) {',
  '  } else fail',
  '  call reviewInvoice(process: "ReviewInvoice") {',
  '    in invoiceDocument',
  '    in creditor',
  '    in amount',
  '    in invoiceCategory',
  '    in invoiceNumber',
  '    out clarified',
  '  }',
  '  if (!clarified) {',
  '    end invoiceNotProcessed(label: "Invoice not\\nprocessed")',
  '  } else if (clarified) {',
  '  } else fail',
  '  goto approveInvoice',
  '}',
  '',
].join('\n');

const categories = (ws: { elementId?: string; category: string }[]) =>
  ws.map((w) => ({ elementId: w.elementId, category: w.category }));

describe('the Operaton invoice example', () => {
  it('imports with the pool, lane and dropped-extra warnings, prints one clean structured script that prints again unchanged, and re-desugars to the same reachability', async () => {
    const { ir: imported, warnings: importWarnings } = await xmlToIr(FIXTURE);
    expect(categories(importWarnings)).toEqual([
      { elementId: 'Accountant', category: 'lane' },
      { elementId: 'teamAssistant', category: 'lane' },
      { elementId: 'Approver', category: 'lane' },
      { elementId: 'DataStoreReference_1', category: 'unmappedConstruct' },
      { elementId: 'prepareBankTransfer', category: 'unmappedConstruct' },
      { elementId: 'prepareBankTransfer', category: 'unmappedConstruct' },
      { elementId: 'StartEvent_1', category: 'extensionAttribute' },
      { elementId: 'ServiceTask_1', category: 'rewritten' },
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
      { elementId: 'reviewSuccessful_gw', category: 'droppedCondition' },
    ]);
    expect((await validate(dsl)).diagnostics).toEqual([]);

    const reDesugared = astToIr(await parseToAst(dsl));
    expect(realNodeReachability(reDesugared)).toEqual(
      realNodeReachability(imported),
    );
    const rebuilt = await xmlToIr(await irToXml(reDesugared));
    expect(rebuilt.warnings).toEqual([]);
    expect(irToDsl(rebuilt.ir).source).toEqual(dsl);
  });

  it("the no-fallback version closes both splits with 'else fail', prints the review split as a guard clause back into approval, prints again unchanged, and rebuilds the model unchanged", async () => {
    const { ir: imported } = await xmlToIr(
      fixture('invoice-receipt-no-fallback.bpmn'),
    );
    const { source: dsl, warnings } = irToDsl(imported);
    // The approve route is a back edge: its reach runs on through the printed
    // `if (approved)` chain, whose end is no merge for this split.
    expect(dsl).toEqual(PRINTED_NO_FALLBACK);
    expect(categories(warnings)).toEqual([
      { elementId: 'invoice_approved', category: 'label' },
      { elementId: 'reviewSuccessful_gw', category: 'label' },
    ]);
    expect((await validate(dsl)).diagnostics).toEqual([]);

    const rebuilt = await xmlToIr(
      await irToXml(astToIr(await parseToAst(dsl))),
    );
    const { level, differences } = compareModels(imported, rebuilt.ir);
    expect({ level, differences }).toEqual({ level: 'same', differences: [] });
    expect(irToDsl(rebuilt.ir).source).toEqual(dsl);
  });
});
