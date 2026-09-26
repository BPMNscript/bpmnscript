// invoice-approval-handwritten.bpmn -> IR1 -> DSL -> AST -> IR2 -> XML2 -> IR3.
// IR3 has to be semantically equal to IR1, but hand-named ids meet synthesized
// ones, so both go through helpers/normalize-ir.ts first.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  xmlToIr,
  astToIr,
  irToXml,
  gatewayDefaultFlowId,
  isGateway,
} from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import { theOnly } from './helpers/ir-query.js';
import { parseToAst, printDsl } from './helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HANDWRITTEN_BPMN_PATH = resolve(
  __dirname,
  'golden/invoice-approval-handwritten.bpmn',
);

let ir1: BpmnProcess;
let ir3: BpmnProcess;
let dslSource: string;

beforeAll(async () => {
  ({ ir: ir1 } = await xmlToIr(readFileSync(HANDWRITTEN_BPMN_PATH, 'utf-8')));
  dslSource = printDsl(ir1);
  const xml2 = await irToXml(astToIr(await parseToAst(dslSource)));
  ({ ir: ir3 } = await xmlToIr(xml2));
});

describe('Round-trip equivalence: BPMN -> IR -> DSL -> IR -> XML -> IR', () => {
  it('ir1 and ir3 are semantically equivalent after normalization', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('the hand-named gateway prints as if/else and comes back with a synthesized default flow', () => {
    // The language has no edge-id syntax, so the hand-named `AutoApprovePath`
    // comes back as `Flow_<gatewayId>_default`.
    expect(dslSource).toBe(
      [
        'process invoice-approval {',
        '  var amount: any',
        '  start ReviewStart',
        '  user ReviewInvoice(label: "Review invoice", assignee: "demo")',
        '  if (amount > 1000) {',
        '    user SeniorApproval(label: "Senior approval", assignee: "manager")',
        '  } else {',
        '    service AutoApprove(label: "Auto-approve", class: "com.example.invoice.AutoApproveDelegate")',
        '  }',
        '  end Done',
        '}',
        '',
      ].join('\n'),
    );

    const gw = theOnly(
      ir3,
      'exclusiveGateway',
      (g) => gatewayDefaultFlowId(g) !== undefined,
    );
    expect(gw.defaultFlowId).toMatch(/_default$/);
    expect(
      ir3.sequenceFlows.find((sf) => sf.id === gw.defaultFlowId)?.targetRef,
    ).toBe('AutoApprove');
  });
});

// Each row corrupts ir3 and asserts normalizeIr still reports a difference:
// the re-key rules canonicalize generated ids only, never structure.
describe('normalizeIr preserves structural differences', () => {
  it.each([
    [
      'dropping a sequence flow',
      (ir: BpmnProcess): BpmnProcess => ({
        ...ir,
        sequenceFlows: ir.sequenceFlows.slice(1),
      }),
    ],
    [
      'removing the real split gateway',
      (ir: BpmnProcess): BpmnProcess => ({
        ...ir,
        flowElements: ir.flowElements.filter(
          (fe) => !(fe.kind === 'exclusiveGateway' && fe.id.endsWith('_split')),
        ),
      }),
    ],
    [
      're-targeting a branch flow',
      (ir: BpmnProcess): BpmnProcess => ({
        ...ir,
        sequenceFlows: ir.sequenceFlows.map((sf) =>
          sf.targetRef === 'SeniorApproval'
            ? { ...sf, targetRef: 'AutoApprove' }
            : sf,
        ),
      }),
    ],
    [
      'stripping the split gateway default flow',
      (ir: BpmnProcess): BpmnProcess => ({
        ...ir,
        flowElements: ir.flowElements.map((fe) =>
          isGateway(fe) && gatewayDefaultFlowId(fe) !== undefined
            ? { kind: fe.kind, id: fe.id, name: fe.name }
            : fe,
        ),
      }),
    ],
  ])('%s from ir3 makes the comparison fail', (_title, corrupt) => {
    const corrupted = corrupt(ir3);
    expect(corrupted).not.toEqual(ir3);
    expect(normalizeIr(corrupted)).not.toEqual(normalizeIr(ir1));
  });
});
