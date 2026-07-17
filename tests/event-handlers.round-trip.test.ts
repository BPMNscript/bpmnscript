/**
 * Whole-feature end-to-end: the event layer (error + escalation) round-trip.
 *
 * This is the dedicated end-to-end proof that the try/catch surface survives the
 * full pipeline as a *user* experiences it, over real infrastructure — real
 * Langium parse and validation, real `bpmn-moddle` (via `irToXml`/`xmlToIr`),
 * and real `bpmn-auto-layout` (invoked inside `irToXml`). There is NO Docker and
 * NO engine here; the "real infrastructure" is the unmocked transform chain and
 * the on-disk golden pair.
 *
 * It complements the flat and nesting round-trip suites by driving one
 * order-processing narrative that exercises, in a single program: an
 * `error … message` declaration; a payment `subprocess` that throws (`throw
 * error` inside an `if`), escalates mid-chain (`emit escalation`) and owns an
 * interrupting `on error` handler with both catch bindings; a process-level
 * non-interrupting `on escalation … (code v) alongside` handler; a catch-all
 * `on error` handler; a terminal `throw escalation`; explicit ids on a throw and
 * an emit with a `goto` targeting the named emit; and a process variable named
 * `message` used in a condition (pinning that the contextual event words coexist
 * with same-named variables).
 *
 * The fixture is `golden/event-handlers.bpmnscript`; the frozen pipeline output
 * is `golden/event-handlers.bpmn`. Normalization comes from the shared
 * `helpers/normalize-ir.ts`, which re-keys the synthesised event-handler
 * sub-process ids to a structural trigger signature.
 *
 * Six cases:
 *
 *   1. Golden generation — the pipeline output equals the frozen `.bpmn`
 *      byte-for-byte (the frozen artifact is the diff tripwire; any drift is a
 *      real defect, not a regeneration trigger).
 *   2. Idempotence — `normalizeIr(IR₁)` equals `normalizeIr(IR₃)`; DSL′ re-parses
 *      with zero parser errors; the authored throw/emit ids and the
 *      `errorMessages` entry survive; the handler trigger start carries its event
 *      definition at every hop.
 *   3. Import path — `xmlToIr(frozen)` warns nothing, and the imported IR
 *      restructured back to DSL and re-desugared is normalized-equal to IR₁.
 *   4. DI tripwire — every handler shape in the frozen `.bpmn` lies strictly
 *      inside its parent container's shape bounds, its children inside it, and
 *      there is exactly one `bpmndi:BPMNDiagram`. This case fails if the DI
 *      expansion hint is removed from `irToXml`: an event sub-process is a
 *      disconnected node in its parent's flow graph, and only the
 *      `isExpanded="true"` shape stub makes `bpmn-auto-layout` place it (and its
 *      children) inside the parent bounds.
 *   5. Root sharing — in the frozen XML the `throw error` end event and the
 *      `on error` handler reference the SAME `bpmn:Error`, which carries the
 *      declared `operaton:errorMessage`.
 *   6. Import-first direction — an inline handwritten `.bpmn` (canonical
 *      namespaces, `Flow_`-prefixed flow ids, `camunda:` aliases for the binding
 *      attributes, a hand-named handler id) imports warning-free, prints, and
 *      re-desugars to an IR normalized-equal to the first import — proving both
 *      the `camunda:`/`operaton:` alias normalization and the handler-id re-key.
 *
 * Two health assertions cover the acceptance requirement that both the fixture
 * and the deployable example open validator-clean in the IDE (no diagnostics at
 * all).
 *
 * A note on DSL′ and validation (case 2). DSL′ re-parses cleanly, but it is not
 * asserted to be validator-clean, and cannot be: the restructurer degrades an
 * early-exit branch — a `throw`/`end`/`goto` inside an `if` whose enclosing flow
 * continues past it, which this fixture requires (`throw error` inside an `if`,
 * and the `goto`) — into a `goto` that targets the synthesised join gateway of
 * that `if`. That join has no surface name, so the goto does not resolve at parse
 * time; `astToIr` regenerates the same deterministic join id, so IR₃ is
 * topologically correct and the normalized comparison holds. A plain `end`
 * inside an `if` degrades identically, so this is a property of the restructurer
 * that predates the event layer, not of the event constructs. The printer also
 * always prints a throw/emit id, and a synthesised `Throw_<coord>` id matches a
 * reserved-name pattern when re-parsed. The meaningful validation guarantee — the
 * authored program is clean — is the fixture check below.
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
  EventDefinition,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors nested-subprocess.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The event-layer DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/event-handlers.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/event-handlers.bpmn');

/** The deployable example program that showcases the event layer. */
const EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/order-recovery.bpmnscript',
);

// ---------------------------------------------------------------------------
// Langium services — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the source
 * has any parser error — a round-tripped source that does not re-parse is itself
 * a round-trip failure, so it must abort the test, never be swallowed.
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

/** The `kind` of the flow element with the given id in a container, or `undefined`. */
function kindOf(container: FlowContainer, id: string): string | undefined {
  return container.flowElements.find((fe) => fe.id === id)?.kind;
}

/** Find the sub-process element with the given id in a container's own array. */
function subProcess(
  container: FlowContainer,
  id: string,
): Extract<FlowElement, { kind: 'subProcess' }> {
  const el = container.flowElements.find(
    (fe) => fe.kind === 'subProcess' && fe.id === id,
  );
  if (el === undefined || el.kind !== 'subProcess') {
    throw new Error(`expected a sub-process '${id}' in container '${container.id}'`);
  }
  return el;
}

/**
 * The event definition carried by the trigger start event of the (single)
 * event-handler sub-process directly inside `container` that catches `code`
 * (or is the catch-all when `code` is `undefined`). Recurses into plain
 * sub-processes so a handler at any container depth is reachable. Returns
 * `undefined` when no such handler exists.
 */
function handlerTriggerDef(
  container: FlowContainer,
  match: (def: EventDefinition | undefined) => boolean,
): EventDefinition | undefined {
  for (const fe of container.flowElements) {
    if (fe.kind !== 'subProcess') continue;
    if (fe.triggeredByEvent === true) {
      const start = fe.flowElements.find((e) => e.kind === 'startEvent');
      const def = start?.kind === 'startEvent' ? start.eventDefinition : undefined;
      if (match(def)) return def;
    }
    const nested = handlerTriggerDef(fe, match);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The event definition of the flow element with the given id, or `undefined`. */
function definitionOf(
  container: FlowContainer,
  id: string,
): EventDefinition | undefined {
  const fe = container.flowElements.find((e) => e.id === id);
  if (fe?.kind === 'endEvent' || fe?.kind === 'intermediateThrowEvent') {
    return fe.eventDefinition;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// DI bounds parsing (case 4). The frozen `.bpmn` is a fixed artifact, so its
// `bpmndi:BPMNShape`/`dc:Bounds` pairs are extracted with a scoped regex rather
// than pulling in a moddle dependency the tests workspace does not declare.
// (Mirrors nested-subprocess.round-trip.test.ts.)
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
 * Assert every direct child shape of every sub-process (plain or handler) lies
 * strictly inside that sub-process's own shape, recursively. The root process
 * has no shape, so its direct children are not bounded — the recursion still
 * descends into its sub-processes.
 */
function assertShapeContainment(
  container: FlowContainer,
  bounds: Map<string, Bounds>,
  isRoot: boolean,
): void {
  const parentBounds = isRoot ? undefined : bounds.get(container.id);
  if (!isRoot) {
    expect(parentBounds, `sub-process ${container.id} has no BPMNShape`).toBeDefined();
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

/**
 * The `errorRef` on the single `bpmn:errorEventDefinition` inside the named
 * start/end event of the frozen XML. Scopes to the element block so the two
 * throw/catch sites are read independently.
 */
function errorRefOf(xml: string, elementId: string): string | undefined {
  const block = new RegExp(
    `<bpmn:(?:start|end)Event id="${elementId}"[^>]*>([\\s\\S]*?)</bpmn:(?:start|end)Event>`,
  ).exec(xml);
  if (block === null) return undefined;
  return /<bpmn:errorEventDefinition\b[^>]*\berrorRef="([^"]+)"/.exec(block[1]!)?.[1];
}

// ---------------------------------------------------------------------------
// The import-first handwritten fixture (case 6). Canonical namespaces,
// `Flow_`-prefixed flow ids, a hand-named event sub-process (`RecoverBoom`),
// `camunda:` aliases for the error root message and the catch bindings, and
// labels that differ from the name humanised from each id. It imports
// warning-free and, printed and re-desugared, is normalized-equal to the first
// import — proving alias normalization and handler-id re-keying.
// ---------------------------------------------------------------------------

const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:error id="Error_Boom" name="BOOM" errorCode="BOOM" camunda:errorMessage="It went boom" />
  <bpmn:process id="import-first" name="Import First" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_DoWork</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="DoWork" name="Perform the work" operaton:class="com.example.WorkDelegate">
      <bpmn:incoming>Flow_Begin_DoWork</bpmn:incoming>
      <bpmn:outgoing>Flow_DoWork_Finish</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="Finish">
      <bpmn:incoming>Flow_DoWork_Finish</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_DoWork" sourceRef="Begin" targetRef="DoWork" />
    <bpmn:sequenceFlow id="Flow_DoWork_Finish" sourceRef="DoWork" targetRef="Finish" />
    <bpmn:subProcess id="RecoverBoom" triggeredByEvent="true">
      <bpmn:startEvent id="CaughtBoom">
        <bpmn:outgoing>Flow_CaughtBoom_Cleanup</bpmn:outgoing>
        <bpmn:errorEventDefinition id="ErrDef_1" errorRef="Error_Boom" camunda:errorCodeVariable="code" camunda:errorMessageVariable="text" />
      </bpmn:startEvent>
      <bpmn:serviceTask id="Cleanup" name="Clean things up" operaton:class="com.example.CleanupDelegate">
        <bpmn:incoming>Flow_CaughtBoom_Cleanup</bpmn:incoming>
        <bpmn:outgoing>Flow_Cleanup_Recovered</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Recovered">
        <bpmn:incoming>Flow_Cleanup_Recovered</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_CaughtBoom_Cleanup" sourceRef="CaughtBoom" targetRef="Cleanup" />
      <bpmn:sequenceFlow id="Flow_Cleanup_Recovered" sourceRef="Cleanup" targetRef="Recovered" />
    </bpmn:subProcess>
  </bpmn:process>
</bpmn:definitions>`;

// ---------------------------------------------------------------------------
// Pipeline — run once in beforeAll; each test makes focused assertions.
// ---------------------------------------------------------------------------

let fixtureSrc: string;
let exampleSrc: string;
let frozenXml: string;
let generatedXml: string; // irToXml(astToIr(parse(fixture)))
let ir1: BpmnProcess; // astToIr(parse(fixture))
let ir2: BpmnProcess; // xmlToIr(generatedXml) — the imported IR
let ir3: BpmnProcess; // re-desugared after DSL → XML → DSL′
let dslPrime: string; // restructured DSL after one XML round-trip
let importWarnings: string[];
let irFromImport: BpmnProcess; // xmlToIr(frozen).ir → re-desugared

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);

  fixtureSrc = readFileSync(FIXTURE_PATH, 'utf-8');
  exampleSrc = readFileSync(EXAMPLE_PATH, 'utf-8');
  frozenXml = readFileSync(FROZEN_BPMN_PATH, 'utf-8');

  ir1 = astToIr(await parseToAst(fixtureSrc));

  generatedXml = await irToXml(ir1);

  ({ ir: ir2 } = await xmlToIr(generatedXml));
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

  it('the restructured DSL′ re-parses with zero parser errors', async () => {
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('the authored throw and emit ids survive verbatim at their correct depth', () => {
    // `throw error PaymentFailed` lives one container down, in the payment
    // sub-process; `emit escalation FlagForReview` is a process-level node.
    const payment = subProcess(ir3, 'ProcessPayment');
    expect(kindOf(payment, 'PaymentFailed')).toBe('endEvent');
    expect(kindOf(ir3, 'FlagForReview')).toBe('intermediateThrowEvent');
  });

  it('the errorMessages entry survives the round-trip', () => {
    expect(ir3.errorMessages).toEqual([
      { code: 'PAYMENT_DECLINED', message: 'The payment was declined by the bank' },
    ]);
  });

  it('the handler trigger start carries its event definition at every hop', () => {
    // The payment sub-process owns an interrupting `on error "PAYMENT_DECLINED"`
    // handler; its trigger start must carry that error definition in IR₁ (from
    // the fixture), IR₂ (imported from the generated XML), and IR₃ (re-desugared).
    const isPaymentError = (def: EventDefinition | undefined): boolean =>
      def?.kind === 'error' && def.errorCode === 'PAYMENT_DECLINED';
    for (const ir of [ir1, ir2, ir3]) {
      const payment = subProcess(ir, 'ProcessPayment');
      const def = handlerTriggerDef(payment, isPaymentError);
      expect(def, `handler error definition missing in a hop`).toBeDefined();
      if (def?.kind === 'error') {
        expect(def.codeVariable).toBe('c');
        expect(def.messageVariable).toBe('m');
      }
    }
  });

  it('the terminal escalation end and the escalation emit keep their definitions', () => {
    // The process-level `emit escalation FlagForReview "MANUAL_REVIEW"` is an
    // intermediate throw; the terminal `throw escalation "ORDER_ABANDONED"` is a
    // typed end event. Both carry an escalation definition in IR₃.
    expect(definitionOf(ir3, 'FlagForReview')).toEqual({
      kind: 'escalation',
      escalationCode: 'MANUAL_REVIEW',
    });
    const terminal = ir3.flowElements.find(
      (fe) =>
        fe.kind === 'endEvent' &&
        fe.eventDefinition?.kind === 'escalation' &&
        fe.eventDefinition.escalationCode === 'ORDER_ABANDONED',
    );
    expect(terminal, 'terminal throw escalation missing').toBeDefined();
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
// 4. DI tripwire on the frozen artifact.
// ===========================================================================

describe('DI containment on the generated .bpmn', () => {
  it('exactly one bpmndi:BPMNDiagram is emitted', () => {
    expect(generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  });

  it('every handler shape (and its children) lies strictly inside its parent bounds', () => {
    // Checked against the freshly generated XML (case 1 pins it to the frozen
    // artifact byte-for-byte): removing the `isExpanded="true"` expansion stub
    // from `irToXml` makes this assertion fail — an event sub-process is a
    // disconnected node whose box and children the layout library only places
    // inside the parent when that stub is present.
    const bounds = parseShapeBounds(generatedXml);

    // Guard against a vacuous pass: the handler shapes must actually be present.
    // The payment handler is nested one level, so it must fall inside the
    // ProcessPayment sub-process shape — the disconnected-node layout guarantee
    // that only the DI expansion stub provides.
    const payment = subProcess(ir1, 'ProcessPayment');
    const handlerIds = payment.flowElements
      .filter((fe) => fe.kind === 'subProcess')
      .map((fe) => fe.id);
    expect(handlerIds.length).toBeGreaterThan(0);
    for (const id of [...handlerIds, 'CaughtPayment', 'NotifyCustomer']) {
      expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
    }

    // Walk the IR so parent→child membership is authoritative at every depth.
    assertShapeContainment(ir1, bounds, true);
  });
});

// ===========================================================================
// 5. Root sharing.
// ===========================================================================

describe('root sharing on the frozen .bpmn', () => {
  it('the throw error end event and the on error handler share one bpmn:Error carrying the message', () => {
    // Exactly one error root, carrying the declared message.
    const roots = [
      ...frozenXml.matchAll(
        /<bpmn:error id="([^"]+)"[^>]*errorCode="PAYMENT_DECLINED"[^>]*operaton:errorMessage="([^"]+)"/g,
      ),
    ];
    expect(roots).toHaveLength(1);
    const [, rootId, message] = roots[0]!;
    expect(message).toBe('The payment was declined by the bank');

    // Both the `throw error PaymentFailed` end event and the `on error` handler's
    // trigger start (`CaughtPayment`) reference that same root element.
    expect(errorRefOf(frozenXml, 'PaymentFailed')).toBe(rootId);
    expect(errorRefOf(frozenXml, 'CaughtPayment')).toBe(rootId);
  });
});

// ===========================================================================
// 6. Import-first direction (alias normalization + handler-id re-key).
// ===========================================================================

describe('import-first: a handwritten .bpmn with camunda: aliases round-trips', () => {
  let firstImport: BpmnProcess;
  let firstWarnings: string[];
  let reDesugared: BpmnProcess;
  let importDsl: string;

  beforeAll(async () => {
    const imported = await xmlToIr(IMPORT_FIRST_BPMN);
    firstImport = imported.ir;
    firstWarnings = imported.warnings;
    importDsl = irToDsl(firstImport);
    reDesugared = astToIr(await parseToAst(importDsl));
  });

  it('imports warning-free', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('normalizes the camunda: error message and binding aliases into the DSL', () => {
    // camunda:errorMessage → the `error … message …` declaration; the camunda:
    // binding attributes → the `(code …, message …)` catch parameter, with
    // `code` doubling as an ordinary variable name.
    expect(importDsl).toContain('error "BOOM" message "It went boom"');
    expect(importDsl).toContain('on error "BOOM" (code code, message text) {');
  });

  it('the hand-named handler is re-keyed so the re-desugared IR matches the import', () => {
    // The hand-named `RecoverBoom` event sub-process has no surface id and is
    // re-synthesised on re-desugaring; the structural re-key in normalizeIr
    // collapses the two ids so the comparison holds.
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(firstImport));
  });
});

// ===========================================================================
// Authored-program health: both the fixture and the deployable example open
// validator-clean in the IDE.
// ===========================================================================

describe('the authored programs open validator-clean', () => {
  it('the fixture produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(fixtureSrc);
    expect(diagnostics).toEqual([]);
  });

  it('the deployable example produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(exampleSrc);
    expect(diagnostics).toEqual([]);
  });
});
