// A hand-named import meets synthesized ids on the way back, so IR1 and IR3
// are compared through normalizeIr.

import { describe, it, expect } from 'vitest';
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

const HANDWRITTEN_BPMN = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    'golden/invoice-approval-handwritten.bpmn',
  ),
  'utf-8',
);

// Each corruption must still show after normalization: the re-key rules
// canonicalize generated ids only, never structure.
const CORRUPTIONS: [string, (ir: BpmnProcess) => BpmnProcess][] = [
  [
    'dropping a sequence flow',
    (ir) => ({ ...ir, sequenceFlows: ir.sequenceFlows.slice(1) }),
  ],
  [
    'removing the real split gateway',
    (ir) => ({
      ...ir,
      flowElements: ir.flowElements.filter(
        (fe) => !(fe.kind === 'exclusiveGateway' && fe.id.endsWith('_split')),
      ),
    }),
  ],
  [
    're-targeting a branch flow',
    (ir) => ({
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
    (ir) => ({
      ...ir,
      flowElements: ir.flowElements.map((fe) =>
        isGateway(fe) && gatewayDefaultFlowId(fe) !== undefined
          ? { kind: fe.kind, id: fe.id, name: fe.name }
          : fe,
      ),
    }),
  ],
];

describe('round trip: BPMN -> IR -> DSL -> IR -> XML -> IR', () => {
  it('the hand-named gateway prints as if/else, comes back with a synthesized default flow, and IR3 equals IR1 but for any structural corruption', async () => {
    const { ir: ir1 } = await xmlToIr(HANDWRITTEN_BPMN);
    const dslSource = printDsl(ir1);
    const xml2 = await irToXml(astToIr(await parseToAst(dslSource)));
    const { ir: ir3 } = await xmlToIr(xml2);

    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
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

    // No edge-id syntax, so `AutoApprovePath` comes back as `Flow_<gateway>_default`.
    const gw = theOnly(
      ir3,
      'exclusiveGateway',
      (g) => gatewayDefaultFlowId(g) !== undefined,
    );
    expect(gw.defaultFlowId).toMatch(/_default$/);
    expect(
      ir3.sequenceFlows.find((sf) => sf.id === gw.defaultFlowId)?.targetRef,
    ).toBe('AutoApprove');

    for (const [title, corrupt] of CORRUPTIONS) {
      const corrupted = corrupt(ir3);
      expect(corrupted, title).not.toEqual(ir3);
      expect(normalizeIr(corrupted), title).not.toEqual(normalizeIr(ir1));
    }
  });
});
