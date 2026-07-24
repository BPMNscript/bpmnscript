/**
 * Health check for the two deployable examples exercised by
 * `tests/e2e/service-boundary-and-compensation.test.ts`: `charge-with-recovery`
 * (an interrupting error boundary attached to a service task) and
 * `compensating-saga` (a completed compensable subprocess unwound from inside
 * a process-level error handler). This mirrors the "the deployable example
 * opens validator-clean" assertion carried by the other event-layer round-trip
 * and example suites (see `order-handling-example.test.ts`), pinning the
 * emitted shape each example is meant to demonstrate without needing Docker.
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

const CHARGE_WITH_RECOVERY_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/charge-with-recovery.bpmnscript',
);

const COMPENSATING_SAGA_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/compensating-saga.bpmnscript',
);

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;
let chargeWithRecoverySrc: string;
let compensatingSagaSrc: string;

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
  chargeWithRecoverySrc = readFileSync(CHARGE_WITH_RECOVERY_PATH, 'utf-8');
  compensatingSagaSrc = readFileSync(COMPENSATING_SAGA_PATH, 'utf-8');
});

describe('the charge-with-recovery deployable example', () => {
  it('opens validator-clean in the IDE', async () => {
    const { diagnostics } = await validate(chargeWithRecoverySrc);
    expect(diagnostics).toEqual([]);
  });

  it('compiles to BPMN XML with an interrupting error boundary on the charge service task', async () => {
    const document = await parse(chargeWithRecoverySrc);
    expect(document.parseResult.parserErrors).toEqual([]);

    const xml = await irToXml(astToIr(document.parseResult.value));

    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
    );
  });
});

describe('the compensating-saga deployable example', () => {
  it('opens validator-clean in the IDE', async () => {
    const { diagnostics } = await validate(compensatingSagaSrc);
    expect(diagnostics).toEqual([]);
  });

  it('compiles to BPMN XML with the undo handler wired over the compensable subprocess', async () => {
    const document = await parse(compensatingSagaSrc);
    expect(document.parseResult.parserErrors).toEqual([]);

    const xml = await irToXml(astToIr(document.parseResult.value));

    // The compensable subprocess...
    expect(xml).toContain(
      '<bpmn:subProcess id="ReserveSeat" name="Reserve the seat">',
    );
    // ...owns a nested triggered-by-event subprocess catching compensation...
    expect(xml).toMatch(
      /<bpmn:subProcess id="EventSubProcess_compensating-saga_\d+(?:_\d+)?" triggeredByEvent="true">[\s\S]*?<bpmn:compensateEventDefinition \/>/,
    );
    // ...whose body runs the undo step.
    expect(xml).toContain(
      '<bpmn:serviceTask id="ReleaseSeat" name="Release the seat" operaton:class="com.example.demo.LogDelegate">',
    );
  });
});
