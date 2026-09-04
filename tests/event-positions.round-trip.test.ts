// The terminate end ends its branch, so DSL' prints that branch as a `goto`
// onto the named service task rather than as the authored `if`/`else`. The IR
// is the same either way, and every node is named, so DSL' still validates
// clean.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess, FlowElement } from '@bpmn-script/transform';

import { describeNoOverlappingShapes } from './helpers/di-bounds.js';
import { elementById, theOnly } from './helpers/ir-query.js';
import { definitionRefOf, messageRoots } from './helpers/xml-query.js';
import { roundTripFixture } from './helpers/round-trip-fixture.js';

const rt = roundTripFixture('event-positions', {
  dslPrimeFrom: 'frozen',
  importPath: true,
  recompile: 'clean',
});

function endEvent(
  container: BpmnProcess,
  id: string,
): Extract<FlowElement, { kind: 'endEvent' }> {
  const found = elementById(container, id);
  if (found.kind !== 'endEvent') {
    throw new Error(`expected '${id}' to be an end event, found ${found.kind}`);
  }
  return found;
}

describe("idempotence: golden .bpmn -> IR2 -> DSL' -> IR3", () => {
  it('the message start keeps its correlation name at every hop', () => {
    for (const [label, ir] of rt.hops) {
      expect(
        theOnly(ir, 'startEvent').eventDefinition,
        `start trigger differs in ${label}`,
      ).toEqual({ kind: 'message', messageName: 'OrderReceived' });
    }
  });

  it('the terminate end keeps its trigger and its label at every hop', () => {
    for (const [label, ir] of rt.hops) {
      const abandon = endEvent(ir, 'OrderAbandoned');
      expect(abandon.eventDefinition, `trigger differs in ${label}`).toEqual({
        kind: 'terminate',
      });
      expect(abandon.name, `label differs in ${label}`).toBe(
        'Abandon every path',
      );
    }
  });

  it("the decompiled DSL' writes each position back on its own statement", () => {
    expect(rt.dslPrime).toContain(
      'start OrderReceived "An order arrives" message "OrderReceived"',
    );
    expect(rt.dslPrime).toContain(
      'emit message NotifyWarehouse "WarehouseNotified"',
    );
    expect(rt.dslPrime).toContain(
      'end OrderAbandoned "Abandon every path" terminate',
    );
    expect(rt.dslPrime).toContain(
      'throw message OrderAcknowledged "OrderAcknowledged"',
    );
  });
});

describe('root derivation on the frozen .bpmn', () => {
  it('carries one bpmn:Message per distinct name, in first-appearance order', () => {
    expect(messageRoots(rt.frozenXml).map((root) => root.name)).toEqual([
      'OrderReceived',
      'WarehouseNotified',
      'OrderAcknowledged',
    ]);
  });

  it('the start event carries a messageRef beside its form data', () => {
    const start =
      /<bpmn:startEvent id="OrderReceived"[\s\S]*?<\/bpmn:startEvent>/.exec(
        rt.frozenXml,
      )?.[0];
    expect(
      start,
      'no OrderReceived start event in the frozen artifact',
    ).toBeDefined();
    expect(start).toContain('<operaton:formData>');
    expect(definitionRefOf(rt.frozenXml, 'OrderReceived', 'message')).toBe(
      messageRoots(rt.frozenXml)[0]!.id,
    );
  });
});

describeNoOverlappingShapes(rt);
