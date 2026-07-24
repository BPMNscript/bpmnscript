/**
 * Whole-feature end-to-end: embedded sub-process round-trip.
 *
 * This is the dedicated end-to-end proof that the containment feature survives
 * the full pipeline as a *user* experiences it, over real infrastructure — real
 * Langium parse and validation, real `bpmn-moddle` (via `irToXml`/`xmlToIr`),
 * and real `bpmn-auto-layout` (invoked inside `irToXml`). There is NO Docker
 * and NO engine here; the "real infrastructure" is the unmocked transform chain
 * and the on-disk golden pair.
 *
 * It complements the flat round-trip suites (`tests/round-trip.test.ts`,
 * `tests/round-trip-constructs.test.ts`) by driving a nested program — a
 * sub-process with an implicit start/end wrapping an `if`/`else`, a labelled
 * sub-process with an explicit start/end wrapping a `while`, and a two-level
 * nested sub-process — through the chain
 *
 *   DSL → IR₁ → XML → IR₂ → DSL′ → IR₃
 *
 * The fixture is `golden/nested-subprocess.bpmnscript`; the frozen pipeline
 * output is `golden/nested-subprocess.bpmn`. Normalization comes from the
 * shared `helpers/normalize-ir.ts`, which recurses into each sub-process
 * container so nested comparison is meaningful.
 *
 * Five cases:
 *
 *   1. Golden generation — the pipeline output equals the frozen `.bpmn`
 *      byte-for-byte (the frozen artifact is the diff tripwire; any drift is a
 *      real defect, not a regeneration trigger).
 *   2. Idempotence — `normalizeIr(IR₁)` equals `normalizeIr(IR₃)`; DSL′
 *      re-parses with zero parser errors and recompiles without validation
 *      errors; authored ids (tasks, explicit events, sub-process names)
 *      survive verbatim at their correct container depth.
 *   3. Import path — `xmlToIr(frozen)` warns nothing, and the imported IR
 *      restructured back to DSL and re-desugared is normalized-equal to IR₁.
 *   4. DI sanity — every nested child shape in the frozen `.bpmn` lies strictly
 *      inside its parent sub-process's shape bounds, at every depth (the
 *      end-to-end restatement of the layout containment guarantee, over the
 *      real user-facing artifact; this case fails if the DI expansion hint is
 *      removed from `irToXml`).
 *   5. Structure — IR₁ assertions pinning the containment shape: each nested
 *      container holds its own elements and flows, no sequence flow crosses a
 *      container boundary, and the parent chain threads through both
 *      sub-processes as opaque activities.
 *
 * A sixth assertion, independent of the round-trip, covers the fixture
 * itself: it opens validator-clean in the IDE (no diagnostics at all).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The nested-sub-process DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/nested-subprocess.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/nested-subprocess.bpmn');

// ---------------------------------------------------------------------------
// Langium services — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the source
 * has any parser error — a round-tripped source that does not re-parse is
 * itself a round-trip failure, so it must abort the test, never be swallowed.
 */
async function parseToAst(source: string) {
  const document = await parse(source);
  const errors = document.parseResult.parserErrors;
  if (errors.length > 0) {
    throw new Error(
      'Parser errors in round-tripped DSL:\n' +
        errors.map((e) => e.message).join('\n'),
    );
  }
  return document.parseResult.value;
}

// ---------------------------------------------------------------------------
// Container helpers.
// ---------------------------------------------------------------------------

/** Find the sub-process element with the given id in a container's own array. */
function subProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(
      `expected a sub-process '${id}' in container '${container.id}'`,
    );
  }
  return el;
}

/** The `kind` of the flow element with the given id, or `undefined`. */
function kindOf(container: FlowContainer, id: string): string | undefined {
  return container.flowElements.find((fe) => fe.id === id)?.kind;
}

/** The set of flow-element ids directly held by a container. */
function idsOf(container: FlowContainer): Set<string> {
  return new Set(container.flowElements.map((fe) => fe.id));
}

/**
 * Assert that no sequence flow in `container` references an element outside the
 * container's own flow-element set — the invariant that lets a parent treat a
 * sub-process as one opaque activity. Recurses into nested containers.
 */
function assertNoBoundaryCrossingFlows(container: FlowContainer): void {
  const own = idsOf(container);
  for (const flow of container.sequenceFlows) {
    expect(
      own.has(flow.sourceRef),
      `flow ${flow.id} source ${flow.sourceRef} escapes container ${container.id}`,
    ).toBe(true);
    expect(
      own.has(flow.targetRef),
      `flow ${flow.id} target ${flow.targetRef} escapes container ${container.id}`,
    ).toBe(true);
  }
  for (const fe of container.flowElements) {
    if (fe.kind === 'subProcess') assertNoBoundaryCrossingFlows(fe);
  }
}

// ---------------------------------------------------------------------------
// DI bounds parsing (case 4). The frozen `.bpmn` is a fixed artifact, so its
// `bpmndi:BPMNShape`/`dc:Bounds` pairs are extracted with a scoped regex rather
// than pulling in a moddle dependency the tests workspace does not declare.
// ---------------------------------------------------------------------------

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Map every `bpmnElement` id to the bounds of its `bpmndi:BPMNShape`. */
function parseShapeBounds(xml: string): Map<string, Bounds> {
  const shape =
    /<bpmndi:BPMNShape\b[^>]*\bbpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  const bounds = new Map<string, Bounds>();
  for (let m = shape.exec(xml); m !== null; m = shape.exec(xml)) {
    bounds.set(m[1]!, {
      x: Number(m[2]),
      y: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
    });
  }
  return bounds;
}

/** True when `child` lies strictly inside `parent` on every side. */
function strictlyInside(child: Bounds, parent: Bounds): boolean {
  return (
    child.x > parent.x &&
    child.y > parent.y &&
    child.x + child.width < parent.x + parent.width &&
    child.y + child.height < parent.y + parent.height
  );
}

/**
 * Assert every direct child shape of every sub-process lies strictly inside
 * that sub-process's own shape, recursively. The root process has no shape, so
 * its direct children are not bounded — the recursion still descends into its
 * sub-processes.
 */
function assertShapeContainment(
  container: FlowContainer,
  bounds: Map<string, Bounds>,
  isRoot: boolean,
): void {
  const parentBounds = isRoot ? undefined : bounds.get(container.id);
  if (!isRoot) {
    expect(
      parentBounds,
      `sub-process ${container.id} has no BPMNShape`,
    ).toBeDefined();
  }
  for (const fe of container.flowElements) {
    if (parentBounds !== undefined) {
      const childBounds = bounds.get(fe.id);
      expect(childBounds, `child ${fe.id} has no BPMNShape`).toBeDefined();
      expect(
        strictlyInside(childBounds!, parentBounds),
        `${fe.id} ${JSON.stringify(childBounds)} not inside ${container.id} ${JSON.stringify(parentBounds)}`,
      ).toBe(true);
    }
    if (fe.kind === 'subProcess') {
      assertShapeContainment(fe, bounds, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline — run once in beforeAll; each test makes focused assertions.
// ---------------------------------------------------------------------------

let fixtureSrc: string;
let frozenXml: string;
let generatedXml: string; // irToXml(astToIr(parse(fixture)))
let ir1: BpmnProcess; // astToIr(parse(fixture))
let ir3: BpmnProcess; // re-desugared after DSL → XML → DSL′
let dslPrime: string; // restructured DSL after one XML round-trip
let importWarnings: string[];
let irFromImport: BpmnProcess; // xmlToIr(frozen).ir → re-desugared

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);

  fixtureSrc = readFileSync(FIXTURE_PATH, 'utf-8');
  frozenXml = readFileSync(FROZEN_BPMN_PATH, 'utf-8');

  ir1 = astToIr(await parseToAst(fixtureSrc));

  generatedXml = await irToXml(ir1);

  const { ir: ir2 } = await xmlToIr(generatedXml);
  dslPrime = irToDsl(ir2);
  ir3 = astToIr(await parseToAst(dslPrime));

  const imported = await xmlToIr(frozenXml);
  importWarnings = imported.warnings;
  irFromImport = astToIr(await parseToAst(irToDsl(imported.ir)));
});

// ===========================================================================
// 1. Golden generation.
// ===========================================================================

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('irToXml(astToIr(parse(fixture))) equals the frozen artifact byte-for-byte', () => {
    expect(generatedXml).toBe(frozenXml);
  });
});

// ===========================================================================
// 2. Idempotence.
// ===========================================================================

describe('idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃', () => {
  it('normalizeIr(IR₁) equals normalizeIr(IR₃)', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('the decompiled DSL recompiles without validation errors', async () => {
    const { diagnostics } = await validate(dslPrime);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it('the restructured DSL′ re-parses with zero parser errors', async () => {
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('the restructured DSL′ reconstructs both sub-processes as `subprocess` blocks', () => {
    expect(dslPrime).toContain('subprocess Payment "Handle payment" {');
    expect(dslPrime).toContain('subprocess Fulfillment "Fulfill the order" {');
    expect(dslPrime).toContain('subprocess Shipping "Ship the parcel" {');
    // The pre-existing constructs survive inside the new one.
    expect(dslPrime).toContain('if (amount > 1000)');
    expect(dslPrime).toContain('while (retries < 3)');
  });

  it('authored ids survive verbatim at their correct container depth', () => {
    // Top level: the two sub-processes are opaque activities in the parent.
    expect(kindOf(ir3, 'OrderReceived')).toBe('startEvent');
    expect(kindOf(ir3, 'RecordOrder')).toBe('userTask');
    expect(kindOf(ir3, 'Payment')).toBe('subProcess');
    expect(kindOf(ir3, 'Fulfillment')).toBe('subProcess');
    expect(kindOf(ir3, 'CloseOrder')).toBe('userTask');
    expect(kindOf(ir3, 'OrderClosed')).toBe('endEvent');

    // Payment body (if/else): its tasks live one level down, not in the parent.
    const payment = subProcess(ir3, 'Payment');
    expect(kindOf(payment, 'ManualReview')).toBe('userTask');
    expect(kindOf(payment, 'AutoCharge')).toBe('serviceTask');
    expect(idsOf(ir3).has('ManualReview')).toBe(false);

    // Fulfillment body (explicit start/end + while + nested sub-process).
    const fulfillment = subProcess(ir3, 'Fulfillment');
    expect(kindOf(fulfillment, 'FulfillmentStart')).toBe('startEvent');
    expect(kindOf(fulfillment, 'FulfillmentDone')).toBe('endEvent');
    expect(kindOf(fulfillment, 'ReserveStock')).toBe('serviceTask');
    expect(kindOf(fulfillment, 'Shipping')).toBe('subProcess');

    // Two-level nesting: Shipping's tasks are two containers deep.
    const shipping = subProcess(fulfillment, 'Shipping');
    expect(kindOf(shipping, 'PackParcel')).toBe('userTask');
    expect(kindOf(shipping, 'DispatchParcel')).toBe('serviceTask');
    expect(idsOf(fulfillment).has('PackParcel')).toBe(false);
  });
});

// ===========================================================================
// 3. Import path.
// ===========================================================================

describe('import path: the frozen artifact imports cleanly and round-trips', () => {
  it('xmlToIr(frozen) produces no warnings', () => {
    expect(importWarnings).toEqual([]);
  });

  it('imported → DSL → re-desugared IR is normalized-equal to IR₁', () => {
    expect(normalizeIr(irFromImport)).toEqual(normalizeIr(ir1));
  });
});

// ===========================================================================
// 4. DI sanity on the frozen artifact.
// ===========================================================================

describe('DI containment on the frozen .bpmn', () => {
  it('every nested child shape lies strictly inside its parent sub-process bounds', () => {
    const bounds = parseShapeBounds(frozenXml);

    // Guard against a vacuous pass: the nested shapes must actually be present.
    for (const id of ['Payment', 'Fulfillment', 'Shipping', 'PackParcel']) {
      expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
    }

    // Walk the imported (nested) IR so parent→child membership is authoritative.
    assertShapeContainment(ir1, bounds, true);
  });
});

// ===========================================================================
// 5. Structure (IR₁ containment shape).
// ===========================================================================

describe('structure: IR₁ pins the containment shape', () => {
  it('the parent chain threads start → RecordOrder → Payment → Fulfillment → CloseOrder → end', () => {
    const edge = (source: string) =>
      ir1.sequenceFlows.find((f) => f.sourceRef === source)?.targetRef;
    expect(edge('OrderReceived')).toBe('RecordOrder');
    expect(edge('RecordOrder')).toBe('Payment');
    expect(edge('Payment')).toBe('Fulfillment');
    expect(edge('Fulfillment')).toBe('CloseOrder');
    expect(edge('CloseOrder')).toBe('OrderClosed');
  });

  it('nested elements do not leak into the parent container', () => {
    const top = idsOf(ir1);
    for (const nested of [
      'ManualReview',
      'AutoCharge',
      'ReserveStock',
      'PackParcel',
      'DispatchParcel',
      'FulfillmentStart',
      'FulfillmentDone',
    ]) {
      expect(top.has(nested)).toBe(false);
    }
  });

  it('each sub-process holds its own body elements', () => {
    const payment = subProcess(ir1, 'Payment');
    expect(idsOf(payment)).toContain('ManualReview');
    expect(idsOf(payment)).toContain('AutoCharge');

    const fulfillment = subProcess(ir1, 'Fulfillment');
    expect(idsOf(fulfillment)).toContain('ReserveStock');
    expect(idsOf(fulfillment)).toContain('Shipping');

    const shipping = subProcess(fulfillment, 'Shipping');
    expect(idsOf(shipping)).toContain('PackParcel');
    expect(idsOf(shipping)).toContain('DispatchParcel');
  });

  it('no sequence flow crosses a container boundary, at any depth', () => {
    assertNoBoundaryCrossingFlows(ir1);
  });
});

// ===========================================================================
// Fixture health: it opens validator-clean in the IDE.
// ===========================================================================

describe('the fixture opens validator-clean', () => {
  it('produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(fixtureSrc);
    expect(diagnostics).toEqual([]);
  });
});
