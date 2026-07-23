/**
 * Health check for the deployable `order-handling` example: the sub-process
 * containment demo that also carries the project's boundary-event walkthrough
 * (a non-interrupting timer plus an interrupting and a non-interrupting message
 * on the review task, an interrupting error and a non-interrupting escalation
 * on the payment sub-process). This mirrors the "the deployable example opens
 * validator-clean" assertion carried by the other event-layer round-trip
 * suites (see `event-handlers.round-trip.test.ts`, `event-triggers.round-trip.test.ts`),
 * scoped to this one example since it has no dedicated golden fixture of its
 * own.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr, irToXml } from '@bpmn-script/transform';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/order-handling.bpmnscript',
);

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;
let exampleSrc: string;

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
  exampleSrc = readFileSync(EXAMPLE_PATH, 'utf-8');
});

describe('the order-handling deployable example', () => {
  it('opens validator-clean in the IDE', async () => {
    const { diagnostics } = await validate(exampleSrc);
    expect(diagnostics).toEqual([]);
  });

  it('compiles to BPMN XML with the expected attached boundary events', async () => {
    const document = await parse(exampleSrc);
    expect(document.parseResult.parserErrors).toEqual([]);

    const xml = await irToXml(astToIr(document.parseResult.value));

    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ReviewOrder_timer" cancelActivity="false" attachedToRef="ReviewOrder">',
    );
    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ReviewOrder_message" attachedToRef="ReviewOrder">',
    );
    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ReviewOrder_message_2" cancelActivity="false" attachedToRef="ReviewOrder">',
    );
    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_Payment_error" attachedToRef="Payment">',
    );
    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_Payment_escalation" cancelActivity="false" attachedToRef="Payment">',
    );
  });
});
