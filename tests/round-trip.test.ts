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
 *   - Synthesized pass-through XOR/AND join gateways (`Gateway_<X>_join` with a
 *     single out-flow) are inlined — the handwritten import has no join, but
 *     `irToDsl→astToIr` re-synthesizes one for every `if/else`.
 *   - Gateway ids are re-keyed by structural position, so the hand-named
 *     `AmountCheck` and the synthesized `Gateway_<coord>_split` collapse.
 *   - All `/^Flow_/`- or gateway-touching flow ids (and the gateway
 *     `defaultFlowId`) are re-keyed to `Flow_<source>_<target>`, so the
 *     hand-named `AutoApprovePath` and the synthesized `Flow_<gw>_default`
 *     collapse.
 *   - The elided gateway `name` is stripped (a structured `if/else` cannot
 *     carry it).
 *
 * NOTE: the negative `operaton:expression`-rejection case in
 * `tests/e2e/invoice-approval.test.ts` (test 3) stays VALID — only
 * `operaton:class` service tasks are currently supported. It is expected to
 * INVERT once `expression`/`delegateExpression` service tasks become supported
 * syntax. Do not change that E2E negative case while that support is absent.
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

  it('all flow element kinds survive the round-trip (after normalization)', () => {
    // The RAW round-trip does NOT preserve the flow-element set: `irToDsl`
    // collapses the hand-named gateway into `if/else`, and `astToIr`
    // re-synthesizes BOTH a split gateway AND a new XOR join node the
    // handwritten IR never had. After `normalizeIr` inlines that synthesized
    // pass-through join, the element kinds are identical on both halves.
    const kinds1 = normalizeIr(ir1)
      .flowElements.map((fe) => fe.kind)
      .sort();
    const kinds3 = normalizeIr(ir3)
      .flowElements.map((fe) => fe.kind)
      .sort();
    expect(kinds3).toEqual(kinds1);
  });

  it('sequence flow count is preserved across the round-trip (after normalization)', () => {
    // Same reason as above: the synthesized join adds one extra flow in the
    // raw ir3 (`branch → join → Done` is two flows where the handwritten IR has
    // one `branch → Done`). After the join is inlined by `normalizeIr`, the
    // flow counts match.
    expect(normalizeIr(ir3).sequenceFlows).toHaveLength(
      normalizeIr(ir1).sequenceFlows.length,
    );
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

  it('gateway has a synthesized default flow that points at the AutoApprove branch', () => {
    // The language has no `as: AutoApprovePath` explicit-flow-id edge syntax:
    // after `irToDsl` collapses the gateway into `if/else`, `astToIr`
    // re-synthesizes the default flow id deterministically as
    // `Flow_<gatewayId>_default` — NOT the hand-named `AutoApprovePath`.
    //
    // We assert the *behavioral invariant* — the split gateway HAS a default
    // flow, that flow id ends in `_default`, and it routes to the AutoApprove
    // branch — rather than pinning the literal hand-named string. The split
    // gateway is the one with a `defaultFlowId`; the synthesized join has none.
    const gw = ir3.flowElements.find(
      (fe) => fe.kind === 'exclusiveGateway' && fe.defaultFlowId !== undefined,
    );
    expect(gw).toBeDefined();
    if (gw?.kind === 'exclusiveGateway') {
      expect(gw.defaultFlowId).toBeDefined();
      expect(gw.defaultFlowId).toMatch(/_default$/);

      const defaultFlow = ir3.sequenceFlows.find(
        (sf) => sf.id === gw.defaultFlowId,
      );
      expect(defaultFlow).toBeDefined();
      expect(defaultFlow!.targetRef).toBe('AutoApprove');
    }
  });

  it('DSL intermediate output parses without errors', async () => {
    const document = await parse(dslSource);

    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(dslSource).toContain('process invoice-approval');
  });

  it('intermediate DSL is structured syntax (if/else blocks, no gateway/edge)', () => {
    // Proves `irToDsl` emits structured syntax, not a node/edge form. The
    // gateway is rendered as an `if (…) { … } else { … }`.
    expect(dslSource).toContain('if (');
    expect(dslSource).toContain('else');
    expect(dslSource).toContain('{');

    // No `gateway` keyword or `->` edge syntax appears (the language does not
    // have either). Match the keyword (followed by whitespace), not a bare
    // substring, so an element name or comment containing "gateway" cannot make
    // this vacuous.
    expect(dslSource).not.toMatch(/\bgateway\s/);
    expect(dslSource).not.toContain('->');
  });
});

// ---------------------------------------------------------------------------
// Meaningfulness guard — the normalizer must NOT mask structural regressions.
//
// These tests deliberately corrupt `ir3` and assert that `normalizeIr` still
// reports a difference. They are the executable proof that the widened re-key
// rules canonicalize generated *ids* only, never genuinely-different
// *structure*.
// ---------------------------------------------------------------------------

describe('normalizeIr is not a regression-masking sieve', () => {
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
        (fe) =>
          !(fe.kind === 'exclusiveGateway' && fe.id.endsWith('_split')),
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
    // Mirrors the `defaultFlowId` assertion above: a gateway's default flow is
    // load-bearing structure. Stripping it must make the NORMALIZED comparison
    // fail — proving `normalizeIr` canonicalizes ids only, never the
    // `defaultFlowId` field, so the round-trip equality is not masking the loss.
    const splitGw = ir3.flowElements.find(
      (fe) => fe.kind === 'exclusiveGateway' && fe.defaultFlowId !== undefined,
    );
    expect(splitGw).toBeDefined();

    const stripped: BpmnProcess = {
      ...ir3,
      flowElements: ir3.flowElements.map((fe) =>
        fe.kind === 'exclusiveGateway' && fe.defaultFlowId !== undefined
          ? { kind: fe.kind, id: fe.id, name: fe.name }
          : fe,
      ),
    };
    expect(normalizeIr(stripped)).not.toEqual(normalizeIr(ir1));
  });
});
