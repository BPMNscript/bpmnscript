/**
 * Round-trip equivalence test.
 *
 * Asserts that the full pipeline
 *
 *   input.bpmn → IR₁ → DSL → AST → IR₂ → XML₂ → IR₃
 *
 * produces an IR₃ that is semantically equivalent to IR₁ (modulo
 * array-ordering and auto-generated flow ids — both normalised by
 * `normalizeIr` before comparison).
 *
 * This is an integration-level test: it exercises every real transform in the
 * chain without mocks, but has no Docker or network dependency and therefore
 * runs in well under 5 seconds.
 *
 * Transform chain:
 *   1. Read `tests/golden/invoice-approval-handwritten.bpmn` from disk.
 *   2. `xmlToIr(xml)` → `ir1`.
 *   3. `irToDsl(ir1)` → `dslSource`.
 *   4. Parse `dslSource` via Langium → AST  (using `parseHelper` from
 *      `langium/test` with `EmptyFileSystem`).
 *   5. `astToIr(ast)` → `ir2`.
 *   6. `irToXml(ir2)` → `xml2`.
 *   7. `xmlToIr(xml2)` → `ir3`.
 *   8. Assert `normalizeIr(ir1)` deep-equals `normalizeIr(ir3)`.
 *
 * Normalization rules (see `helpers/normalize-ir.ts`):
 *   - `flowElements` and `sequenceFlows` are sorted by id.
 *   - Auto-generated flow ids (`/^Flow_/`) are replaced with
 *     `Flow_<sourceRef>_<targetRef>` so both halves collapse to the same key.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the hand-written BPMN fixture. */
const HANDWRITTEN_BPMN_PATH = resolve(
  __dirname,
  'golden/invoice-approval-handwritten.bpmn',
);

// ---------------------------------------------------------------------------
// Pipeline — executed once in beforeAll; each test makes one focused assertion.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let ir1: BpmnProcess;
let ir3: BpmnProcess;
let dslSource: string;

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);

  // Step 1 — read the hand-written BPMN fixture.
  const xml = readFileSync(HANDWRITTEN_BPMN_PATH, 'utf-8');

  // Step 2 — parse BPMN XML into IR.
  ir1 = await xmlToIr(xml);

  // Step 3 — pretty-print IR to DSL source.
  dslSource = irToDsl(ir1);

  // Step 4 — parse the DSL source via Langium.
  const document = await parse(dslSource);
  if (document.parseResult.parserErrors.length > 0) {
    throw new Error(
      'Parser errors in round-tripped DSL:\n' +
        document.parseResult.parserErrors.map((e) => e.message).join('\n'),
    );
  }

  // Step 5 — convert AST to IR.
  const ir2 = astToIr(document.parseResult.value);

  // Step 6 — serialize IR to BPMN XML.
  const xml2 = await irToXml(ir2);

  // Step 7 — parse the generated XML back to IR.
  ir3 = await xmlToIr(xml2);
});

// ---------------------------------------------------------------------------
// Round-trip equivalence
// ---------------------------------------------------------------------------

describe('Round-trip equivalence: BPMN → IR → DSL → IR → XML → IR', () => {
  it('ir1 and ir3 are semantically equivalent after normalization', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('process metadata (id, name, isExecutable) survives the round-trip', () => {
    expect(ir3.id).toBe(ir1.id);
    expect(ir3.name).toBe(ir1.name);
    expect(ir3.isExecutable).toBe(true);
  });

  it('all flow element kinds survive the round-trip', () => {
    const kinds1 = ir1.flowElements.map((fe) => fe.kind).sort();
    const kinds3 = ir3.flowElements.map((fe) => fe.kind).sort();
    expect(kinds3).toEqual(kinds1);
  });

  it('sequence flow count is preserved across the round-trip', () => {
    expect(ir3.sequenceFlows).toHaveLength(ir1.sequenceFlows.length);
  });

  it('operaton attributes (assignee, javaClass) survive the round-trip', () => {
    const reviewTask3 = ir3.flowElements.find(
      (fe) => fe.kind === 'userTask' && fe.id === 'ReviewInvoice',
    );
    expect(reviewTask3).toBeDefined();
    if (reviewTask3?.kind === 'userTask') {
      expect(reviewTask3.assignee).toBe('demo');
    }

    const serviceTask3 = ir3.flowElements.find(
      (fe) => fe.kind === 'serviceTask',
    );
    expect(serviceTask3).toBeDefined();
    if (serviceTask3?.kind === 'serviceTask') {
      expect(serviceTask3.javaClass).toBe(
        'com.example.invoice.AutoApproveDelegate',
      );
    }
  });

  it('conditionExpression survives the round-trip', () => {
    const conditionalFlow = ir3.sequenceFlows.find(
      (sf) => sf.conditionExpression !== undefined,
    );
    expect(conditionalFlow).toBeDefined();
    expect(conditionalFlow!.conditionExpression).toBe('${amount > 1000}');
  });

  it('gateway defaultFlowId survives the round-trip', () => {
    const gw = ir3.flowElements.find((fe) => fe.kind === 'exclusiveGateway');
    expect(gw).toBeDefined();
    if (gw?.kind === 'exclusiveGateway') {
      expect(gw.defaultFlowId).toBe('AutoApprovePath');
    }
  });

  it('DSL intermediate output parses without errors', async () => {
    const document = await parse(dslSource);

    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(dslSource).toContain('process invoice-approval');
  });
});
