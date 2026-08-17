/**
 * End-to-end round-trip for the compensation (undo-block) event layer over the
 * unmocked transform chain: real Langium parse and validation, real
 * `bpmn-moddle` via `irToXml`/`xmlToIr`, and real `bpmn-auto-layout` inside
 * `irToXml`. No Docker and no engine.
 *
 * One trip-booking saga exercises two `subprocess`es each owning an
 * `on compensation` undo block (one reversing in a single step, one through an
 * `if` over a declared form variable), an `on error` handler that raises a named
 * `emit compensation` and keeps going, an `on escalation` handler that ends its
 * path with a named `throw compensation`, and a `var compensation: number` read
 * in a service expression, pinning that the particle word coexists with a
 * same-named variable.
 *
 * The frozen `.bpmn` is a diff tripwire: drift in it is a defect, not a reason
 * to regenerate.
 *
 * Why the restructured DSL stays validator-clean: every throw and emit is
 * explicitly named, so the printer emits the authored id rather than a
 * `Throw_<coord>` id that would trip the reserved-name check, and the guards
 * read variables declared on the start form, so they survive the XML round-trip.
 * The `var compensation` declaration vanishes on that round-trip, but its only
 * reference sits inside an opaque service expression the validator never parses.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { xmlToIr, irToDsl, astToIr } from '@bpmn-script/transform';
import type {
  BpmnProcess,
  EventDefinition,
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';
import {
  parseShapeBounds,
  assertShapeContainment,
} from './helpers/di-bounds.js';
import { subProcess } from './helpers/ir-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('compensation', {
  example: 'compensating-saga',
  importPath: true,
  recompile: 'clean',
});

/**
 * The event definition on the trigger start of the first event-handler
 * sub-process, at any container depth, whose definition satisfies `match`.
 * Recurses into plain sub-processes so a nested handler is reachable.
 */
function findHandlerDef(
  container: FlowContainer,
  match: (def: EventDefinition | undefined) => boolean,
): EventDefinition | undefined {
  for (const fe of container.flowElements) {
    if (fe.kind !== 'subProcess') continue;
    if (fe.triggeredByEvent === true) {
      const start = fe.flowElements.find((e) => e.kind === 'startEvent');
      const def =
        start?.kind === 'startEvent' ? start.eventDefinition : undefined;
      if (match(def)) return def;
    }
    const nested = findHandlerDef(fe, match);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

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
 * The event definition of the flow element with the given id, searched at any
 * depth so a throw or emit inside an `on` handler body is reachable.
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

const isCompensation = (def: EventDefinition | undefined): boolean =>
  def?.kind === 'compensation';

/**
 * The opening tag of the named `bpmn:startEvent` in the frozen XML, up to the
 * first `>`, so a test can read whether `isInterrupting` is present.
 */
function startEventOpenTag(xml: string, id: string): string | undefined {
  return new RegExp(`<bpmn:startEvent id="${id}"[^>]*>`).exec(xml)?.[0];
}

/**
 * A handwritten import-first fixture: a hand-named compensation event
 * sub-process hosted by its plain sub-process, an `emit`-style compensation
 * intermediate throw, and a compensation end event whose definition carries an
 * explicit `waitForCompletion="true"` (the moddle default, accepted on import
 * and then dropped as unmodeled). Every task label differs from the name
 * humanised from its id, so the importer keeps it.
 */
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

describe('idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃', () => {
  it('the authored emit and throw ids survive verbatim through their handlers', () => {
    // `emit compensation` is a continuing undo request (an intermediate throw);
    // `throw compensation` undoes and ends its path (a typed end event).
    expect(findDeep(rt.ir3, 'Undo')?.kind).toBe('intermediateThrowEvent');
    expect(findDeep(rt.ir3, 'CancelAll')?.kind).toBe('endEvent');
    expect(definitionOf(rt.ir3, 'Undo')).toEqual({ kind: 'compensation' });
    expect(definitionOf(rt.ir3, 'CancelAll')).toEqual({ kind: 'compensation' });
  });

  it('both undo-block handler starts carry a compensation trigger at every hop', () => {
    for (const ir of [rt.ir1, rt.ir2, rt.ir3]) {
      for (const host of ['BookFlight', 'BookHotel']) {
        const def = findHandlerDef(subProcess(ir, host), isCompensation);
        expect(def, `undo block missing in ${host} at a hop`).toEqual({
          kind: 'compensation',
        });
      }
    }
  });
});

describe('DI containment on the generated .bpmn', () => {
  it('exactly one bpmndi:BPMNDiagram is emitted', () => {
    expect(rt.generatedXml.match(/<bpmndi:BPMNDiagram\b/g)).toHaveLength(1);
  });

  it('every handler shape (and its children) lies strictly inside its parent bounds', () => {
    const bounds = parseShapeBounds(rt.generatedXml);

    // Guard against a vacuous pass: each booking sub-process must actually own a
    // triggeredByEvent undo block that falls inside its shape.
    for (const host of ['BookFlight', 'BookHotel']) {
      const handlerIds = subProcess(rt.ir1, host)
        .flowElements.filter(
          (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
        )
        .map((fe) => fe.id);
      expect(handlerIds.length).toBeGreaterThan(0);
      for (const id of handlerIds) {
        expect(bounds.has(id), `missing BPMNShape for ${id}`).toBe(true);
      }
    }

    // Walk the IR so parent-child membership is authoritative at every depth.
    assertShapeContainment(rt.ir1, bounds, true);
  });
});

describe('compensation shape pins on the frozen .bpmn', () => {
  it('emits no compensation root element (only the error and escalation roots exist)', () => {
    // Compensation is payload-less, so it contributes no document-level root.
    expect(rt.frozenXml).not.toMatch(/<bpmn:compensation\b/);
    expect(rt.frozenXml.match(/<bpmn:error id="[^"]+"/g)).toHaveLength(1);
    expect(rt.frozenXml.match(/<bpmn:escalation id="[^"]+"/g)).toHaveLength(1);
  });

  it('every bpmn:compensateEventDefinition is attribute-less', () => {
    // Two undo-block trigger starts, one `emit` intermediate throw, and one
    // `throw` end event, all four bare.
    const all =
      rt.frozenXml.match(/<bpmn:compensateEventDefinition\b[^>]*>/g) ?? [];
    expect(all).toHaveLength(4);
    for (const tag of all) {
      expect(tag).toBe('<bpmn:compensateEventDefinition />');
    }
  });

  it('each undo block is a triggeredByEvent sub-process whose start is interrupting', () => {
    // Compensation always interrupts, so the serializer drops the default and
    // the trigger start stores no interrupting flag.
    for (const host of ['BookFlight', 'BookHotel']) {
      const handler = subProcess(rt.ir1, host).flowElements.find(
        (fe) => fe.kind === 'subProcess' && fe.triggeredByEvent === true,
      );
      expect(handler?.kind).toBe('subProcess');
      if (handler?.kind === 'subProcess') {
        const start = handler.flowElements.find((e) => e.kind === 'startEvent');
        expect(
          start?.kind === 'startEvent' && start.isInterrupting,
        ).toBeUndefined();
      }
    }

    for (const startId of ['CancelFlightStart', 'CancelHotelStart']) {
      const tag = startEventOpenTag(rt.frozenXml, startId);
      expect(tag, `start ${startId} not found`).toBeDefined();
      expect(tag).not.toContain('isInterrupting');
    }
  });
});

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
    reDesugared = astToIr(await rt.parseToAst(importDsl));
  });

  it('imports warning-free (the explicit waitForCompletion="true" is accepted)', () => {
    expect(firstWarnings).toEqual([]);
  });

  it('recovers each compensation surface into the DSL', () => {
    expect(importDsl).toContain('subprocess Pick "Pick the whole order" {');
    expect(importDsl).toContain('on compensation {');
    expect(importDsl).toContain('emit compensation Raise');
    expect(importDsl).toContain('throw compensation GiveUp');
  });

  it('the emit and throw resolve to the payload-less compensation kind', () => {
    expect(definitionOf(firstImport, 'Raise')).toEqual({
      kind: 'compensation',
    });
    expect(definitionOf(firstImport, 'GiveUp')).toEqual({
      kind: 'compensation',
    });
  });

  it('the hand-named undo block is re-keyed so the re-desugared IR matches the import', () => {
    expect(normalizeIr(reDesugared)).toEqual(normalizeIr(firstImport));
  });
});
