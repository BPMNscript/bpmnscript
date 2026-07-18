/**
 * Whole-feature end-to-end: the event layer (message, signal, timer, and
 * conditional triggers) round-trip.
 *
 * This is the dedicated end-to-end proof that the four remaining event triggers
 * survive the full pipeline as a *user* experiences it, over real infrastructure
 * — real Langium parse and validation, real `bpmn-moddle` (via
 * `irToXml`/`xmlToIr`), and real `bpmn-auto-layout` (invoked inside `irToXml`).
 * There is NO Docker and NO engine here; the "real infrastructure" is the
 * unmocked transform chain and the on-disk golden pair.
 *
 * It complements the error/escalation end-to-end suite by driving one
 * order-fulfilment narrative that exercises, in a single program: an
 * `on message "OrderCancelled"` process-level handler; a `subprocess` owning a
 * non-interrupting reminder `on timer after "PT2H" alongside` handler and a
 * non-interrupting `on condition (stockLevel < 5) alongside` watchdog whose
 * condition reads a declared form variable; an `on signal "OrderFulfilled"
 * alongside` handler together with an `emit signal Notify "OrderFulfilled"`
 * (continuing broadcast, goto-targeted) and a terminal `throw signal Announce
 * "OrderFulfilled"` of the SAME signal name (so all three share one
 * `bpmn:Signal`); an `at` timer on a second sub-process; an
 * `on error "STOCK_UNAVAILABLE" (code c, message m)` handler with both catch
 * bindings (cross-kind interplay); and a `var timer: string` read in a service
 * expression, pinning that the timer particle words coexist with same-named
 * variables.
 *
 * The fixture is `golden/event-triggers.bpmnscript`; the frozen pipeline output
 * is `golden/event-triggers.bpmn`. Normalization comes from the shared
 * `helpers/normalize-ir.ts`, whose handler re-keying now folds the trigger
 * definition payload (message/signal name, timer kind + expression, condition
 * text) into the structural signature, so two same-kind handlers of the new
 * kinds are distinguishable.
 *
 * Six cases:
 *
 *   1. Golden generation — the pipeline output equals the frozen `.bpmn`
 *      byte-for-byte (the frozen artifact is the diff tripwire; any drift is a
 *      real defect, not a regeneration trigger).
 *   2. Idempotence — `normalizeIr(IR₁)` equals `normalizeIr(IR₃)`; the
 *      restructured DSL′ re-parses with zero parser errors AND is
 *      validator-clean; the conditional handler's condition survives as the same
 *      expression; the timer expressions survive verbatim at every hop.
 *   3. Import path — `xmlToIr(frozen)` warns nothing, and the imported IR
 *      restructured back to DSL and re-desugared is normalized-equal to IR₁.
 *   4. DI tripwire — every handler shape in the generated `.bpmn` lies strictly
 *      inside its parent container's shape bounds, and there is exactly one
 *      `bpmndi:BPMNDiagram`. This case fails if the DI expansion hint is removed
 *      from `irToXml`: an event sub-process is a disconnected node in its
 *      parent's flow graph, and only the `isExpanded="true"` shape stub makes
 *      `bpmn-auto-layout` place it (and its children) inside the parent bounds.
 *   5. Root sharing — in the frozen XML the `on signal` handler start, the
 *      `emit signal` intermediate throw, and the `throw signal` end event all
 *      reference the SAME `bpmn:Signal`, and there is exactly one root per
 *      distinct message/signal/error name.
 *   6. Import-first direction — an inline handwritten `.bpmn` (canonical
 *      namespaces, `Flow_`-prefixed flow ids, hand-named event sub-processes, a
 *      timer with only a `timeDate` child, a conditional with a `bpmn:condition`
 *      body, and TWO same-name `bpmn:Signal` roots referenced by different
 *      elements) imports warning-free, prints, and re-desugars to an IR
 *      normalized-equal to the first import — proving name collapse, handler
 *      re-keying, and the four-kind payload recovery.
 *
 * Two health assertions cover the acceptance requirement that both the fixture
 * and the deployable example open validator-clean in the IDE (no diagnostics at
 * all).
 *
 * A note on DSL′ and validation (case 2). Unlike the error/escalation suite,
 * this fixture's DSL′ IS asserted validator-clean, and can be: it avoids the
 * early-exit-inside-`if` shape that degrades a jump into a goto onto an unnamed
 * synthesised join, and every throw/emit is explicitly named (`Notify`,
 * `Announce`) so the printer emits the authored id — which re-parses cleanly —
 * rather than a `Throw_<coord>` id that would trip the reserved-name check.
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
// File-path resolution (mirrors event-handlers.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The event-trigger DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/event-triggers.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/event-triggers.bpmn');

/** The deployable example program that showcases the trigger layer. */
const EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/order-reminder.bpmnscript',
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
 * The event definition carried by the trigger start event of the first
 * event-handler sub-process — at any container depth — whose definition
 * satisfies `match`. Recurses into plain sub-processes so a handler nested
 * inside a `subprocess` is reachable. Returns `undefined` when none match.
 */
function findHandlerDef(
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
    const nested = findHandlerDef(fe, match);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Every timer expression carried by a handler trigger start anywhere in the
 * containment tree, sorted. The fixture has a duration timer (`PT2H`) one level
 * down in `FulfilOrder` and a date timer (`2026-08-01T09:00:00`) one level down
 * in `ArchiveStage`, so this pins that both survive verbatim at a given hop.
 */
function timerExpressions(container: FlowContainer): string[] {
  const out: string[] = [];
  for (const fe of container.flowElements) {
    if (fe.kind !== 'subProcess') continue;
    if (fe.triggeredByEvent === true) {
      const start = fe.flowElements.find((e) => e.kind === 'startEvent');
      const def = start?.kind === 'startEvent' ? start.eventDefinition : undefined;
      if (def?.kind === 'timer') out.push(def.expression);
    }
    out.push(...timerExpressions(fe));
  }
  return out.sort();
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
// (Mirrors event-handlers.round-trip.test.ts.)
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
 * The `signalRef` on the single `bpmn:signalEventDefinition` inside the named
 * start/end/intermediate-throw event of the frozen XML. Scopes to the element
 * block so the three broadcast sites are read independently.
 */
function signalRefOf(xml: string, elementId: string): string | undefined {
  const block = new RegExp(
    `<bpmn:(?:start|end|intermediateThrow)Event id="${elementId}"[^>]*>([\\s\\S]*?)</bpmn:(?:start|end|intermediateThrow)Event>`,
  ).exec(xml);
  if (block === null) return undefined;
  return /<bpmn:signalEventDefinition\b[^>]*\bsignalRef="([^"]+)"/.exec(block[1]!)?.[1];
}

// ---------------------------------------------------------------------------
// The import-first handwritten fixture (case 6). Canonical namespaces,
// `Flow_`-prefixed flow ids, two hand-named event sub-processes (`WatchStock`
// conditional, `RemindLate` date timer), and TWO `bpmn:Signal` roots that carry
// the same `name="ParcelDispatched"` but are referenced by different elements
// (the intermediate throw references one, the end event the other). It imports
// warning-free and, printed and re-desugared, is normalized-equal to the first
// import — proving the same-name root collapse, the handler-id re-key, and the
// timer/conditional payload recovery. Every task label differs from the name
// humanised from its id so the importer keeps it.
// ---------------------------------------------------------------------------

const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first_triggers" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:signal id="Signal_Sent_A" name="ParcelDispatched" />
  <bpmn:signal id="Signal_Sent_B" name="ParcelDispatched" />
  <bpmn:process id="parcel-tracking" name="Parcel Tracking" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_Dispatch</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Dispatch" name="Send the parcel out" operaton:class="com.example.DispatchDelegate">
      <bpmn:incoming>Flow_Begin_Dispatch</bpmn:incoming>
      <bpmn:outgoing>Flow_Dispatch_Broadcast</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:intermediateThrowEvent id="Broadcast">
      <bpmn:incoming>Flow_Dispatch_Broadcast</bpmn:incoming>
      <bpmn:outgoing>Flow_Broadcast_Done</bpmn:outgoing>
      <bpmn:signalEventDefinition signalRef="Signal_Sent_A" />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="Done">
      <bpmn:incoming>Flow_Broadcast_Done</bpmn:incoming>
      <bpmn:signalEventDefinition signalRef="Signal_Sent_B" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_Dispatch" sourceRef="Begin" targetRef="Dispatch" />
    <bpmn:sequenceFlow id="Flow_Dispatch_Broadcast" sourceRef="Dispatch" targetRef="Broadcast" />
    <bpmn:sequenceFlow id="Flow_Broadcast_Done" sourceRef="Broadcast" targetRef="Done" />
    <bpmn:subProcess id="WatchStock" triggeredByEvent="true">
      <bpmn:startEvent id="LowStock">
        <bpmn:outgoing>Flow_LowStock_Reorder</bpmn:outgoing>
        <bpmn:conditionalEventDefinition>
          <bpmn:condition xsi:type="bpmn:tFormalExpression">\${stockLevel &lt; 5}</bpmn:condition>
        </bpmn:conditionalEventDefinition>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Reorder" name="Reorder the item" operaton:class="com.example.ReorderDelegate">
        <bpmn:incoming>Flow_LowStock_Reorder</bpmn:incoming>
        <bpmn:outgoing>Flow_Reorder_Reordered</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Reordered">
        <bpmn:incoming>Flow_Reorder_Reordered</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_LowStock_Reorder" sourceRef="LowStock" targetRef="Reorder" />
      <bpmn:sequenceFlow id="Flow_Reorder_Reordered" sourceRef="Reorder" targetRef="Reordered" />
    </bpmn:subProcess>
    <bpmn:subProcess id="RemindLate" triggeredByEvent="true">
      <bpmn:startEvent id="Deadline">
        <bpmn:outgoing>Flow_Deadline_Chase</bpmn:outgoing>
        <bpmn:timerEventDefinition>
          <bpmn:timeDate xsi:type="bpmn:tFormalExpression">2026-09-01T08:00:00</bpmn:timeDate>
        </bpmn:timerEventDefinition>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Chase" name="Chase the courier" operaton:class="com.example.ChaseDelegate">
        <bpmn:incoming>Flow_Deadline_Chase</bpmn:incoming>
        <bpmn:outgoing>Flow_Chase_Chased</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="Chased">
        <bpmn:incoming>Flow_Chase_Chased</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:sequenceFlow id="Flow_Deadline_Chase" sourceRef="Deadline" targetRef="Chase" />
      <bpmn:sequenceFlow id="Flow_Chase_Chased" sourceRef="Chase" targetRef="Chased" />
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

  it('the restructured DSL′ is validator-clean (named throws re-parse cleanly)', async () => {
    const { diagnostics } = await validate(dslPrime);
    expect(diagnostics).toEqual([]);
  });

  it('the authored throw and emit ids survive verbatim at process level', () => {
    // `emit signal Notify` is a continuing broadcast (intermediate throw);
    // `throw signal Announce` is a terminal broadcast (typed end event).
    expect(kindOf(ir3, 'Notify')).toBe('intermediateThrowEvent');
    expect(kindOf(ir3, 'Announce')).toBe('endEvent');
    expect(definitionOf(ir3, 'Notify')).toEqual({
      kind: 'signal',
      signalName: 'OrderFulfilled',
    });
    expect(definitionOf(ir3, 'Announce')).toEqual({
      kind: 'signal',
      signalName: 'OrderFulfilled',
    });
  });

  it('the conditional handler condition survives as the same expression at every hop', () => {
    const isConditional = (def: EventDefinition | undefined): boolean =>
      def?.kind === 'conditional';
    for (const ir of [ir1, ir2, ir3]) {
      const def = findHandlerDef(subProcess(ir, 'FulfilOrder'), isConditional);
      expect(def, 'conditional handler missing in a hop').toBeDefined();
      if (def?.kind === 'conditional') {
        expect(def.condition).toBe('${stockLevel < 5}');
      }
    }
  });

  it('the timer expressions survive verbatim at every hop', () => {
    for (const ir of [ir1, ir2, ir3]) {
      expect(timerExpressions(ir)).toEqual([
        '2026-08-01T09:00:00',
        'PT2H',
      ]);
    }
  });

  it('the message handler keeps its correlation name', () => {
    const def = findHandlerDef(ir3, (d) => d?.kind === 'message');
    expect(def).toEqual({ kind: 'message', messageName: 'OrderCancelled' });
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
// 4. DI tripwire on the generated artifact.
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

    // Guard against a vacuous pass: the two handlers nested one level down inside
    // `FulfilOrder` must actually be present and fall inside its shape.
    const fulfil = subProcess(ir1, 'FulfilOrder');
    const handlerIds = fulfil.flowElements
      .filter((fe) => fe.kind === 'subProcess')
      .map((fe) => fe.id);
    expect(handlerIds.length).toBeGreaterThan(0);
    for (const id of handlerIds) {
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
  it('the on signal handler, the emit, and the throw share one bpmn:Signal', () => {
    // Exactly one signal root, carrying the broadcast name.
    const signals = [
      ...frozenXml.matchAll(/<bpmn:signal id="([^"]+)" name="([^"]+)"/g),
    ];
    expect(signals).toHaveLength(1);
    const [, signalId, signalName] = signals[0]!;
    expect(signalName).toBe('OrderFulfilled');

    // The handler start (`FulfilledStart`), the `emit signal Notify` intermediate
    // throw, and the `throw signal Announce` end event all reference that root.
    expect(signalRefOf(frozenXml, 'FulfilledStart')).toBe(signalId);
    expect(signalRefOf(frozenXml, 'Notify')).toBe(signalId);
    expect(signalRefOf(frozenXml, 'Announce')).toBe(signalId);
  });

  it('there is exactly one root per distinct message, signal, and error name', () => {
    expect(frozenXml.match(/<bpmn:message id="[^"]+"/g)).toHaveLength(1);
    expect(frozenXml.match(/<bpmn:signal id="[^"]+"/g)).toHaveLength(1);
    expect(frozenXml.match(/<bpmn:error id="[^"]+"/g)).toHaveLength(1);
  });
});

// ===========================================================================
// 6. Import-first direction (name collapse + handler re-key + payload recovery).
// ===========================================================================

describe('import-first: a handwritten .bpmn with two same-name signals round-trips', () => {
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

  it('imports warning-free (the two same-name signal roots collapse silently)', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('recovers each trigger payload into the DSL surface', () => {
    // The two signal broadcasts print with their authored ids and the collapsed
    // name; the timer prints with its `at` particle and verbatim date; the
    // conditional prints its recovered expression in parens.
    expect(importDsl).toContain('emit signal Broadcast "ParcelDispatched"');
    expect(importDsl).toContain('throw signal Done "ParcelDispatched"');
    expect(importDsl).toContain('on timer at "2026-09-01T08:00:00" {');
    expect(importDsl).toContain('on condition (stockLevel < 5) {');
  });

  it('both broadcasts resolve to the one collapsed signal name', () => {
    // The two roots (`Signal_Sent_A`, `Signal_Sent_B`) share `ParcelDispatched`;
    // both the intermediate throw and the end event carry that one name in the IR.
    expect(definitionOf(firstImport, 'Broadcast')).toEqual({
      kind: 'signal',
      signalName: 'ParcelDispatched',
    });
    expect(definitionOf(firstImport, 'Done')).toEqual({
      kind: 'signal',
      signalName: 'ParcelDispatched',
    });
  });

  it('the hand-named handlers are re-keyed so the re-desugared IR matches the import', () => {
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
