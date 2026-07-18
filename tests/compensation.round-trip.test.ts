/**
 * Whole-feature end-to-end: the compensation (undo-block) event layer
 * round-trip.
 *
 * This is the dedicated end-to-end proof that the final event-layer trigger —
 * compensation — survives the full pipeline as a *user* experiences it, over
 * real infrastructure: real Langium parse and validation, real `bpmn-moddle`
 * (via `irToXml`/`xmlToIr`), and real `bpmn-auto-layout` (invoked inside
 * `irToXml`). There is NO Docker and NO engine here; the "real infrastructure"
 * is the unmocked transform chain and the on-disk golden pair.
 *
 * It drives one trip-booking saga that exercises, in a single program: two
 * `subprocess`es each owning an `on compensation` undo block (the flight
 * booking reverses in one step, the hotel booking reverses through an `if` that
 * reads a declared form variable — undo logic beyond a single step); an
 * `error … message` declaration and a process-level `on error` handler whose
 * body raises a named `emit compensation Undo` (a compensation intermediate
 * throw) and then keeps going to notify the traveller; a matching
 * `emit escalation Overspend` in the main flow together with a process-level
 * `on escalation` handler that gives up — it records the abandonment and ends
 * the path with a named `throw compensation CancelAll` (a compensation end
 * event); and a `var compensation: number` read in a service expression,
 * pinning that the compensation particle word coexists with a same-named
 * variable.
 *
 * The fixture is `golden/compensation.bpmnscript`; the frozen pipeline output is
 * `golden/compensation.bpmn`. Normalization comes from the shared
 * `helpers/normalize-ir.ts`, whose handler re-keying folds the trigger
 * definition payload into the structural signature; compensation is
 * payload-less, so its handler identity is just its container plus the
 * compensation kind — collision-free because a subprocess has at most one undo
 * block.
 *
 * Six cases:
 *
 *   1. Golden generation — the pipeline output equals the frozen `.bpmn`
 *      byte-for-byte (the frozen artifact is the diff tripwire; any drift is a
 *      real defect, not a regeneration trigger).
 *   2. Idempotence — `normalizeIr(IR₁)` equals `normalizeIr(IR₃)`; the
 *      restructured DSL′ re-parses with zero parser errors AND is
 *      validator-clean; the authored `Undo` and `CancelAll` ids survive every
 *      hop; both undo-block handler starts carry `{ kind: 'compensation' }` at
 *      every hop.
 *   3. Import path — `xmlToIr(frozen)` warns nothing, and the imported IR
 *      restructured back to DSL and re-desugared is normalized-equal to IR₁.
 *   4. DI tripwire — every handler shape in the generated `.bpmn` (each undo
 *      block inside its host `subprocess`, each handler-body child inside its
 *      handler) lies strictly inside its parent container's shape bounds, and
 *      there is exactly one `bpmndi:BPMNDiagram`.
 *   5. Shape pins on the frozen XML — no compensation root element exists (only
 *      the error declaration's own root, plus the one escalation root); every
 *      `bpmn:compensateEventDefinition` is attribute-less (no `activityRef`, no
 *      `waitForCompletion`); each undo-block handler is a `triggeredByEvent`
 *      sub-process whose start carries no `isInterrupting`.
 *   6. Import-first direction — an inline handwritten `.bpmn` (canonical
 *      namespaces, `Flow_`-prefixed flow ids, a hand-named compensation event
 *      sub-process hosted directly by its plain sub-process, an `emit`-style
 *      compensation intermediate throw, and a compensation end event whose
 *      definition carries an explicit `waitForCompletion="true"`) imports
 *      warning-free, prints, and re-desugars to an IR normalized-equal to the
 *      first import — proving the compensation payload recovery and the
 *      handler-id re-key.
 *
 * Two health assertions cover the acceptance requirement that both the fixture
 * and the deployable example open validator-clean in the IDE (no diagnostics at
 * all).
 *
 * A note on DSL′ and validation (case 2). Every throw/emit is explicitly named
 * (`Undo`, `CancelAll`, `Overspend`) so the printer emits the authored id —
 * which re-parses cleanly — rather than a `Throw_<coord>` id that would trip the
 * reserved-name check. The undo `if` and the escalation guard read `seats` and
 * `budget`, both declared on the start form so they survive the XML round-trip
 * and keep DSL′ free of undeclared-variable diagnostics. The `var compensation`
 * declaration is a standalone statement, and its only reference lives inside an
 * opaque service expression the validator never parses — so the declaration,
 * which vanishes on the XML round-trip, is never missed.
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
// File-path resolution (mirrors event-triggers.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The compensation DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/compensation.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/compensation.bpmn');

/** The deployable example program that showcases the undo layer. */
const EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/booking-saga.bpmnscript',
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

/** The flow element with the given id anywhere in the containment tree. */
function findDeep(
  container: FlowContainer,
  id: string,
): FlowElement | undefined {
  for (const fe of container.flowElements) {
    if (fe.id === id) return fe;
    if (fe.kind === 'subProcess') {
      const nested = findDeep(fe, id);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * The event definition of the flow element with the given id — searched at any
 * depth, so a throw/emit nested inside an `on` handler body is reachable.
 */
function definitionOf(
  container: FlowContainer,
  id: string,
): EventDefinition | undefined {
  const fe = findDeep(container, id);
  if (fe?.kind === 'endEvent' || fe?.kind === 'intermediateThrowEvent') {
    return fe.eventDefinition;
  }
  return undefined;
}

/** True for a compensation event definition. */
const isCompensation = (def: EventDefinition | undefined): boolean =>
  def?.kind === 'compensation';

// ---------------------------------------------------------------------------
// DI bounds parsing (case 4). The frozen `.bpmn` is a fixed artifact, so its
// `bpmndi:BPMNShape`/`dc:Bounds` pairs are extracted with a scoped regex rather
// than pulling in a moddle dependency the tests workspace does not declare.
// (Mirrors event-triggers.round-trip.test.ts.)
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
 * The opening tag of the named `<bpmn:startEvent id="…" …>` element in the
 * frozen XML (the substring up to the first `>`). Used to read the presence or
 * absence of `isInterrupting` off a compensation handler's trigger start.
 */
function startEventOpenTag(xml: string, id: string): string | undefined {
  return new RegExp(`<bpmn:startEvent id="${id}"[^>]*>`).exec(xml)?.[0];
}

// ---------------------------------------------------------------------------
// The import-first handwritten fixture (case 6). Canonical namespaces,
// `Flow_`-prefixed flow ids, a hand-named compensation event sub-process
// (`ReturnItems`) hosted directly by its plain sub-process (`Pick`), an
// `emit`-style compensation intermediate throw (`Raise`), and a compensation
// end event (`GiveUp`) whose definition carries an explicit
// `waitForCompletion="true"` (the moddle default, which the importer accepts and
// then drops as unmodeled). Every task label differs from the name humanised
// from its id so the importer keeps it. It imports warning-free and, printed and
// re-desugared, is normalized-equal to the first import — proving the
// compensation payload recovery and the handler-id re-key.
// ---------------------------------------------------------------------------

const IMPORT_FIRST_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="Definitions_import_first_compensation" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="warehouse-fulfilment" name="Warehouse Fulfilment" isExecutable="true">
    <bpmn:startEvent id="Begin">
      <bpmn:outgoing>Flow_Begin_Pick</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:subProcess id="Pick" name="Pick the whole order">
      <bpmn:incoming>Flow_Begin_Pick</bpmn:incoming>
      <bpmn:outgoing>Flow_Pick_Raise</bpmn:outgoing>
      <bpmn:startEvent id="PickBegin">
        <bpmn:outgoing>Flow_PickBegin_Grab</bpmn:outgoing>
      </bpmn:startEvent>
      <bpmn:serviceTask id="Grab" name="Take the item off the shelf" operaton:class="com.example.GrabDelegate">
        <bpmn:incoming>Flow_PickBegin_Grab</bpmn:incoming>
        <bpmn:outgoing>Flow_Grab_PickDone</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:endEvent id="PickDone">
        <bpmn:incoming>Flow_Grab_PickDone</bpmn:incoming>
      </bpmn:endEvent>
      <bpmn:subProcess id="ReturnItems" triggeredByEvent="true">
        <bpmn:startEvent id="UndoPick">
          <bpmn:outgoing>Flow_UndoPick_PutBack</bpmn:outgoing>
          <bpmn:compensateEventDefinition />
        </bpmn:startEvent>
        <bpmn:serviceTask id="PutBack" name="Return the item to the shelf" operaton:class="com.example.PutBackDelegate">
          <bpmn:incoming>Flow_UndoPick_PutBack</bpmn:incoming>
          <bpmn:outgoing>Flow_PutBack_UndoDone</bpmn:outgoing>
        </bpmn:serviceTask>
        <bpmn:endEvent id="UndoDone">
          <bpmn:incoming>Flow_PutBack_UndoDone</bpmn:incoming>
        </bpmn:endEvent>
        <bpmn:sequenceFlow id="Flow_UndoPick_PutBack" sourceRef="UndoPick" targetRef="PutBack" />
        <bpmn:sequenceFlow id="Flow_PutBack_UndoDone" sourceRef="PutBack" targetRef="UndoDone" />
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="Flow_PickBegin_Grab" sourceRef="PickBegin" targetRef="Grab" />
      <bpmn:sequenceFlow id="Flow_Grab_PickDone" sourceRef="Grab" targetRef="PickDone" />
    </bpmn:subProcess>
    <bpmn:intermediateThrowEvent id="Raise">
      <bpmn:incoming>Flow_Pick_Raise</bpmn:incoming>
      <bpmn:outgoing>Flow_Raise_GiveUp</bpmn:outgoing>
      <bpmn:compensateEventDefinition />
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="GiveUp">
      <bpmn:incoming>Flow_Raise_GiveUp</bpmn:incoming>
      <bpmn:compensateEventDefinition waitForCompletion="true" />
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Begin_Pick" sourceRef="Begin" targetRef="Pick" />
    <bpmn:sequenceFlow id="Flow_Pick_Raise" sourceRef="Pick" targetRef="Raise" />
    <bpmn:sequenceFlow id="Flow_Raise_GiveUp" sourceRef="Raise" targetRef="GiveUp" />
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

  it('the authored emit and throw ids survive verbatim through their handlers', () => {
    // `emit compensation Undo` (inside the `on error` handler) is a continuing
    // undo request — an intermediate throw; `throw compensation CancelAll`
    // (inside the `on escalation` handler) undoes and ends its path — a typed
    // end event. Both are payload-less and keep their authored ids.
    expect(findDeep(ir3, 'Undo')?.kind).toBe('intermediateThrowEvent');
    expect(findDeep(ir3, 'CancelAll')?.kind).toBe('endEvent');
    expect(definitionOf(ir3, 'Undo')).toEqual({ kind: 'compensation' });
    expect(definitionOf(ir3, 'CancelAll')).toEqual({ kind: 'compensation' });
  });

  it('both undo-block handler starts carry a compensation trigger at every hop', () => {
    for (const ir of [ir1, ir2, ir3]) {
      for (const host of ['BookFlight', 'BookHotel']) {
        const def = findHandlerDef(subProcess(ir, host), isCompensation);
        expect(def, `undo block missing in ${host} at a hop`).toEqual({
          kind: 'compensation',
        });
      }
    }
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
    const bounds = parseShapeBounds(generatedXml);

    // Guard against a vacuous pass: each booking sub-process must actually own a
    // triggeredByEvent undo block that falls inside its shape.
    for (const host of ['BookFlight', 'BookHotel']) {
      const handlerIds = subProcess(ir1, host)
        .flowElements.filter(
          (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
        )
        .map((fe) => fe.id);
      expect(handlerIds.length).toBeGreaterThan(0);
      for (const id of handlerIds) {
        expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
      }
    }

    // Walk the IR so parent→child membership is authoritative at every depth.
    assertShapeContainment(ir1, bounds, true);
  });
});

// ===========================================================================
// 5. Shape pins on the frozen .bpmn.
// ===========================================================================

describe('compensation shape pins on the frozen .bpmn', () => {
  it('emits no compensation root element (only the error and escalation roots exist)', () => {
    // Compensation is payload-less: it contributes no document-level root. The
    // only roots are the declared error and the escalation synthesised from use.
    expect(frozenXml).not.toMatch(/<bpmn:compensation\b/);
    expect(frozenXml.match(/<bpmn:error id="[^"]+"/g)).toHaveLength(1);
    expect(frozenXml.match(/<bpmn:escalation id="[^"]+"/g)).toHaveLength(1);
  });

  it('every bpmn:compensateEventDefinition is attribute-less', () => {
    // Two undo-block trigger starts, one `emit` intermediate throw, one `throw`
    // end event — four in all, and every one bare: no `activityRef`, no
    // `waitForCompletion`.
    const all = frozenXml.match(/<bpmn:compensateEventDefinition\b[^>]*>/g) ?? [];
    expect(all).toHaveLength(4);
    for (const tag of all) {
      expect(tag).toBe('<bpmn:compensateEventDefinition />');
    }
  });

  it('each undo block is a triggeredByEvent sub-process whose start is interrupting', () => {
    // IR side: each booking sub-process's undo block is triggeredByEvent and its
    // trigger start stores no non-default interrupting flag (compensation always
    // interrupts, so the serializer drops the default).
    for (const host of ['BookFlight', 'BookHotel']) {
      const handler = subProcess(ir1, host).flowElements.find(
        (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
      );
      expect(handler?.kind).toBe('subProcess');
      if (handler?.kind === 'subProcess') {
        const start = handler.flowElements.find((e) => e.kind === 'startEvent');
        expect(start?.kind === 'startEvent' && start.isInterrupting).toBeUndefined();
      }
    }

    // XML side: the two authored undo-trigger starts carry no isInterrupting.
    for (const startId of ['CancelFlightStart', 'CancelHotelStart']) {
      const tag = startEventOpenTag(frozenXml, startId);
      expect(tag, `start ${startId} not found`).toBeDefined();
      expect(tag).not.toContain('isInterrupting');
    }
  });
});

// ===========================================================================
// 6. Import-first direction (compensation payload recovery + handler re-key).
// ===========================================================================

describe('import-first: a handwritten .bpmn with an undo block round-trips', () => {
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

  it('imports warning-free (the explicit waitForCompletion="true" is accepted)', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('recovers each compensation surface into the DSL', () => {
    // The undo block prints as a bare `on compensation`, its host as a named
    // `subprocess`, the intermediate throw as `emit compensation`, and the end
    // event as `throw compensation` — every one with its authored id.
    expect(importDsl).toContain('subprocess Pick "Pick the whole order" {');
    expect(importDsl).toContain('on compensation {');
    expect(importDsl).toContain('emit compensation Raise');
    expect(importDsl).toContain('throw compensation GiveUp');
  });

  it('the emit and throw resolve to the payload-less compensation kind', () => {
    expect(definitionOf(firstImport, 'Raise')).toEqual({ kind: 'compensation' });
    expect(definitionOf(firstImport, 'GiveUp')).toEqual({ kind: 'compensation' });
  });

  it('the hand-named undo block is re-keyed so the re-desugared IR matches the import', () => {
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
