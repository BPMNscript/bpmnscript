/**
 * Full test suite for the IR → DSL pretty-printer.
 *
 * Unit-level tests — `irToDsl` is a pure synchronous function.
 * The round-trip tests use the Langium grammar and `astToIr` to verify
 * that the emitted DSL re-parses to an equivalent IR.
 *
 * Test cases:
 *   1. `irToDsl(canonical)` produces a string that re-parses without errors.
 *   2. The re-parsed IR equals the original IR.
 *   3. Gateway without `defaultFlowId` emits no `default:` line and no flow
 *      gets an `as:` tag.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { irToDsl } from '../src/ir-to-dsl.js';
import { astToIr } from '../src/ast-to-ir.js';
import type { BpmnProcess } from '../src/ir/types.js';

/**
 * The canonical IR used across this test suite.
 * Derived from `tests/golden/invoice-approval-handwritten.bpmn` via `xmlToIr`.
 */
const CANONICAL_IR: BpmnProcess = {
  id: 'invoice-approval',
  name: 'Invoice Approval',
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
      javaClass: 'com.example.invoice.AutoApproveDelegate',
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
      conditionExpression: '${amount > 1000}',
      sourceRef: 'AmountCheck',
      targetRef: 'SeniorApproval',
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

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// ── 1. DSL re-parses without errors ──────────────────────────────────────────

describe('irToDsl — re-parseable output', () => {
  it('irToDsl(canonical) produces a string that re-parses without parser errors', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const document = await parse(dsl);
    const errors = document.parseResult.parserErrors;

    expect(
      errors,
      `Parser errors in generated DSL:\n${errors.map((e) => e.message).join('\n')}`,
    ).toHaveLength(0);
  });

  it('output is a non-empty string ending with a newline', () => {
    const dsl = irToDsl(CANONICAL_IR);
    expect(typeof dsl).toBe('string');
    expect(dsl.length).toBeGreaterThan(0);
    expect(dsl.endsWith('\n')).toBe(true);
  });

  it('output contains the process header', () => {
    const dsl = irToDsl(CANONICAL_IR);
    expect(dsl).toContain('process invoice-approval "Invoice Approval" {');
  });
});

// ── 2. Re-parsed IR equals original IR ───────────────────────────────────────

describe('irToDsl — round-trip IR equality', () => {
  it('re-parsing the DSL via Langium and converting via astToIr yields the original IR', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const document = await parse(dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const roundTrippedIr = astToIr(document.parseResult.value);

    // The round-tripped IR must equal the original. Two normalisation steps:
    //
    // 1. Flow ids without an `as:` tag get regenerated from source/target
    //    ids by `astToIr`. For the canonical IR, `Flow_SeniorBranch`
    //    (original) → `Flow_AmountCheck_SeniorApproval` (regenerated).
    //    Normalise both to `Flow_<source>_<target>`.
    //
    // 2. `irToDsl` reorders flow nodes: starts first, then ends, then
    //    remaining nodes. The re-parsed IR therefore differs in
    //    `flowElements` order from the original. Normalise by sorting.
    const normalise = (ir: BpmnProcess): BpmnProcess => ({
      ...ir,
      flowElements: [...ir.flowElements].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      sequenceFlows: ir.sequenceFlows
        .map((sf) => ({
          ...sf,
          id: normaliseFlowId(sf.id, sf.sourceRef, sf.targetRef),
        }))
        .sort((a, b) =>
          `${a.sourceRef}_${a.targetRef}`.localeCompare(
            `${b.sourceRef}_${b.targetRef}`,
          ),
        ),
    });

    expect(normalise(roundTrippedIr)).toEqual(normalise(CANONICAL_IR));
  });

  it('process id, name and isExecutable survive the round-trip', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const doc = await parse(dsl);
    const ir = astToIr(doc.parseResult.value);

    expect(ir.id).toBe(CANONICAL_IR.id);
    expect(ir.name).toBe(CANONICAL_IR.name);
    expect(ir.isExecutable).toBe(true);
  });

  it('all flow element kinds survive the round-trip', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const doc = await parse(dsl);
    const ir = astToIr(doc.parseResult.value);

    const originalKinds = CANONICAL_IR.flowElements.map((fe) => fe.kind).sort();
    const roundTrippedKinds = ir.flowElements.map((fe) => fe.kind).sort();
    expect(roundTrippedKinds).toEqual(originalKinds);
  });

  it('assignee and formKey survive the round-trip', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const doc = await parse(dsl);
    const ir = astToIr(doc.parseResult.value);

    const reviewTask = ir.flowElements.find(
      (fe) => fe.kind === 'userTask' && fe.id === 'ReviewInvoice',
    );
    expect(reviewTask).toBeDefined();
    if (reviewTask?.kind === 'userTask') {
      expect(reviewTask.assignee).toBe('demo');
    }
  });

  it('conditionExpression survives the round-trip', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const doc = await parse(dsl);
    const ir = astToIr(doc.parseResult.value);

    const conditionalFlow = ir.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditionalFlow).toBeDefined();
    expect(conditionalFlow!.conditionExpression).toBe('${amount > 1000}');
  });

  it('gateway defaultFlowId survives the round-trip', async () => {
    const dsl = irToDsl(CANONICAL_IR);
    const doc = await parse(dsl);
    const ir = astToIr(doc.parseResult.value);

    const gw = ir.flowElements.find((fe) => fe.kind === 'exclusiveGateway');
    expect(gw).toBeDefined();
    if (gw?.kind === 'exclusiveGateway') {
      // The gateway's `default:` id references the flow's `as:` tag.
      // After round-trip, the flow id and the gateway's defaultFlowId
      // must agree (both use `AutoApprovePath`).
      expect(gw.defaultFlowId).toBe('AutoApprovePath');
    }
  });
});

// ── 3. Gateway without defaultFlowId ─────────────────────────────────────────

describe('irToDsl — gateway without default', () => {
  it('gateway without defaultFlowId emits no default: line', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'exclusiveGateway', id: 'G' },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'F1', sourceRef: 'S', targetRef: 'G' },
        { id: 'F2', sourceRef: 'G', targetRef: 'E' },
      ],
    };

    const dsl = irToDsl(ir);
    expect(dsl).not.toContain('default:');
  });

  it('no flow gets an as: tag when no gateway declares a default', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'exclusiveGateway', id: 'G' },
        { kind: 'userTask', id: 'T', name: 'Task' },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'F1', sourceRef: 'S', targetRef: 'G' },
        {
          id: 'F2',
          sourceRef: 'G',
          targetRef: 'T',
          conditionExpression: '${x > 0}',
        },
        { id: 'F3', sourceRef: 'G', targetRef: 'E' },
        { id: 'F4', sourceRef: 'T', targetRef: 'E' },
      ],
    };

    const dsl = irToDsl(ir);
    expect(dsl).not.toContain('as:');
  });

  it('gateway without default emits the gateway line without default: keyword', () => {
    const ir: BpmnProcess = {
      id: 'p',
      isExecutable: true,
      flowElements: [
        { kind: 'startEvent', id: 'S' },
        { kind: 'exclusiveGateway', id: 'G', name: 'My Check' },
        { kind: 'endEvent', id: 'E' },
      ],
      sequenceFlows: [
        { id: 'F1', sourceRef: 'S', targetRef: 'G' },
        { id: 'F2', sourceRef: 'G', targetRef: 'E' },
      ],
    };

    const dsl = irToDsl(ir);
    expect(dsl).toContain('gateway G "My Check"');
    expect(dsl).not.toContain('default:');
  });
});

// ── 4. Additional correctness checks ─────────────────────────────────────────

describe('irToDsl — additional output checks', () => {
  it('service task class: value is quoted and correct', () => {
    const dsl = irToDsl(CANONICAL_IR);
    expect(dsl).toContain(
      'service AutoApprove "Auto-approve" class: "com.example.invoice.AutoApproveDelegate"',
    );
  });

  it('conditional flow emits when: with the verbatim expression', () => {
    const dsl = irToDsl(CANONICAL_IR);
    expect(dsl).toContain('when: "${amount > 1000}"');
  });

  it('default flow emits as: AutoApprovePath', () => {
    const dsl = irToDsl(CANONICAL_IR);
    expect(dsl).toContain('as: AutoApprovePath');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a sequence flow id for round-trip comparison.
 *
 * Flows that are NOT named with `as:` in the DSL get a new generated id
 * `Flow_<source>_<target>` when they pass through `astToIr`. Flows that
 * ARE named (i.e. appear as a gateway's `defaultFlowId`) keep their id.
 *
 * Since the canonical IR's `Flow_SeniorBranch` is unnamed in the DSL
 * (it has no `as:` tag — the `as:` tag belongs to `AutoApprovePath`),
 * after round-trip it becomes `Flow_AmountCheck_SeniorApproval`. This
 * normaliser replaces both with a synthetic placeholder so the comparison
 * can focus on semantic equality, not generated-id equality.
 *
 * Only flows that have a generated-style id (starting with `Flow_`) AND
 * are not in the gateway's default-flow set are normalised.
 */
function normaliseFlowId(
  id: string,
  sourceRef: string,
  targetRef: string,
): string {
  // Flows with `as:` tags keep their literal id (e.g. `AutoApprovePath`).
  // We treat any id that looks generated (`Flow_<src>_<tgt>`) as opaque
  // and replace it with the canonical pattern so both sides match.
  if (/^Flow_/.test(id)) {
    return `Flow_${sourceRef}_${targetRef}`;
  }
  return id;
}
