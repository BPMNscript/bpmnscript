// The Operaton invoice example, the thesis's demonstration process: a pool
// wrapping three lanes, a data store and its reference, an unreferenced
// message root, and an approve/review loop whose inner split names no
// default (`invoice_approved`). `describeImportFirst` asserts a warning-free
// import, which this document is not, so the pipeline is driven by hand
// here: every per-feature suite in this package pins one shape apiece, and
// this one pins that the whole file survives import, print, re-parse,
// validation and a second import together.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, astToIr, irToDsl, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { realNodeReachability } from './helpers/real-node-reachability.js';
import { parseToAst, validate } from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/invoice-receipt.bpmn'),
  'utf-8',
);

// The whole print: the start, the async respelling on the archive step, both
// loop variables declared, the review loop restructured as `do ... while`
// and no dropped edge. The assignment listener keeps its script body,
// printed like `on create` just above it; the listener carries no settings,
// so no parens precede the fenced body.
const PRINTED = [
  'process invoice(label: "Invoice Receipt", versionTag: "V2.0", historyTimeToLive: "45") {',
  '  var clarified: any',
  '  var approved: any',
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

describe('the Operaton invoice example', () => {
  let imported: BpmnProcess;
  let importWarnings: Awaited<ReturnType<typeof xmlToIr>>['warnings'];
  let dsl: string;
  let printWarnings: ReturnType<typeof irToDsl>['warnings'];
  let reDesugared: BpmnProcess;

  beforeAll(async () => {
    ({ ir: imported, warnings: importWarnings } = await xmlToIr(FIXTURE));
    const printed = irToDsl(imported);
    dsl = printed.source;
    printWarnings = printed.warnings;
    reDesugared = astToIr(await parseToAst(dsl));
  });

  it('imports with exactly the warnings the pool, lanes and dropped extras produce', () => {
    expect(
      importWarnings.map((w) => ({
        elementId: w.elementId,
        category: w.category,
      })),
    ).toEqual([
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
  });

  it('prints the whole process as one structured script', () => {
    expect(dsl).toEqual(PRINTED);

    expect(
      printWarnings.map((w) => ({
        elementId: w.elementId,
        category: w.category,
      })),
    ).toEqual([
      { elementId: 'invoice_approved', category: 'label' },
      { elementId: 'reviewSuccessful_gw', category: 'label' },
      { elementId: 'invoice_approved', category: 'defaultFlow' },
      { elementId: 'reviewSuccessful_gw', category: 'droppedCondition' },
    ]);
  });

  it('validates with no diagnostics at all', async () => {
    const { diagnostics } = await validate(dsl);
    expect(diagnostics).toEqual([]);
  });

  it('re-desugars to the import reachability plus the join edges the default-less split invents, and re-imports clean', async () => {
    // `invoice_approved` names no default: the else-less `if`/`else if` chain
    // the printer emits for it falls through to the loop gateway on
    // recompile, which gains `approveInvoice` every pair that gateway reaches.
    expect(realNodeReachability(reDesugared)).toEqual(
      [
        ...realNodeReachability(imported),
        'approveInvoice->approveInvoice',
        'approveInvoice->invoiceNotProcessed',
      ].sort(),
    );

    const { warnings: secondImportWarnings } = await xmlToIr(
      await irToXml(reDesugared),
    );
    expect(secondImportWarnings).toEqual([]);
  });
});
