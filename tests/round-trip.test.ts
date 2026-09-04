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
import { parse, parseToAst, printDsl } from './helpers/pipeline.js';

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

  it('process metadata (id, name, isExecutable) survives the round-trip', () => {
    expect(ir3.id).toBe(ir1.id);
    expect(ir3.name).toBe(ir1.name);
    expect(ir3.isExecutable).toBe(true);
  });

  it('all flow element kinds survive the round-trip (after normalization)', () => {
    // irToDsl collapses the hand-named gateway into `if/else` and astToIr
    // re-synthesizes a split plus a join the handwritten IR never had, so the
    // raw flow-element set cannot match. Inlining the join makes them comparable.
    const kinds1 = normalizeIr(ir1)
      .flowElements.map((fe) => fe.kind)
      .sort();
    const kinds3 = normalizeIr(ir3)
      .flowElements.map((fe) => fe.kind)
      .sort();
    expect(kinds3).toEqual(kinds1);
  });

  it('sequence flow count is preserved across the round-trip (after normalization)', () => {
    // Same reason: `branch -> join -> Done` is two flows, the handwritten IR
    // has one `branch -> Done`.
    expect(normalizeIr(ir3).sequenceFlows).toHaveLength(
      normalizeIr(ir1).sequenceFlows.length,
    );
  });

  it('operaton attributes (assignee, class binding) survive the round-trip', () => {
    const review = theOnly(ir3, 'userTask', (t) => t.id === 'ReviewInvoice');
    expect(review.assignee).toBe('demo');

    expect(theOnly(ir3, 'serviceTask').binding).toEqual({
      kind: 'class',
      className: 'com.example.invoice.AutoApproveDelegate',
    });
  });

  it('conditionExpression survives the round-trip', () => {
    const conditionalFlow = ir3.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditionalFlow).toBeDefined();
    expect(conditionalFlow!.conditionExpression).toBe('${amount > 1000}');
  });

  it('gateway has a synthesized default flow that points at the AutoApprove branch', () => {
    // The language has no edge-id syntax, so the hand-named `AutoApprovePath`
    // comes back as `Flow_<gatewayId>_default`. Assert the behavior, not the
    // literal id.
    const gw = theOnly(
      ir3,
      'exclusiveGateway',
      (g) => gatewayDefaultFlowId(g) !== undefined,
    );
    expect(gw.defaultFlowId).toMatch(/_default$/);

    const defaultFlow = ir3.sequenceFlows.find(
      (sf) => sf.id === gw.defaultFlowId,
    );
    expect(defaultFlow).toBeDefined();
    expect(defaultFlow!.targetRef).toBe('AutoApprove');
  });

  it('DSL intermediate output parses without errors', async () => {
    const document = await parse(dslSource);

    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(dslSource).toContain('process invoice-approval');
  });

  it('intermediate DSL is structured syntax (if/else blocks, no gateway/edge)', () => {
    expect(dslSource).toContain('if (');
    expect(dslSource).toContain('else');
    expect(dslSource).toContain('{');

    // Keyword plus whitespace, not a bare substring: an element named
    // "...gateway..." would otherwise make this vacuous.
    expect(dslSource).not.toMatch(/\bgateway\s/);
    expect(dslSource).not.toContain('->');
  });
});

// Each case corrupts ir3 and asserts normalizeIr still reports a difference:
// the re-key rules canonicalize generated ids only, never structure.
describe('normalizeIr preserves structural differences', () => {
  it('dropping a sequence flow from ir3 makes the comparison FAIL', () => {
    const ir3Corrupt: BpmnProcess = {
      ...ir3,
      sequenceFlows: ir3.sequenceFlows.slice(1),
    };
    expect(normalizeIr(ir3Corrupt)).not.toEqual(normalizeIr(ir1));
  });

  it('removing the real split gateway from ir3 makes the comparison FAIL', () => {
    const ir3Corrupt: BpmnProcess = {
      ...ir3,
      flowElements: ir3.flowElements.filter(
        (fe) => !(fe.kind === 'exclusiveGateway' && fe.id.endsWith('_split')),
      ),
    };
    expect(normalizeIr(ir3Corrupt)).not.toEqual(normalizeIr(ir1));
  });

  it('re-targeting a branch flow in ir3 makes the comparison FAIL', () => {
    const ir3Corrupt: BpmnProcess = {
      ...ir3,
      sequenceFlows: ir3.sequenceFlows.map((sf) =>
        sf.targetRef === 'SeniorApproval'
          ? { ...sf, targetRef: 'AutoApprove' }
          : sf,
      ),
    };
    expect(normalizeIr(ir3Corrupt)).not.toEqual(normalizeIr(ir1));
  });

  it('stripping the split gateway default flow makes the comparison FAIL', () => {
    // A gateway's default flow is structure, so normalizeIr must not erase it.
    const splitGw = ir3.flowElements.find(
      (fe) => isGateway(fe) && gatewayDefaultFlowId(fe) !== undefined,
    );
    expect(splitGw).toBeDefined();

    const stripped: BpmnProcess = {
      ...ir3,
      flowElements: ir3.flowElements.map((fe) =>
        isGateway(fe) && gatewayDefaultFlowId(fe) !== undefined
          ? { kind: fe.kind, id: fe.id, name: fe.name }
          : fe,
      ),
    };
    expect(normalizeIr(stripped)).not.toEqual(normalizeIr(ir1));
  });
});
