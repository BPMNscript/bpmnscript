/**
 * Health check for every deployable example under
 * `examples/spring-boot/processes/`.
 *
 * The sweep is directory-driven rather than a hand-kept list, so a new example
 * is covered the moment it is added: every one of them must open
 * validator-clean, the same bar the IDE holds an author to.
 *
 * A handful of examples are also the only place a construct's desugared or
 * emitted shape is pinned without a golden fixture, so those keep a block of
 * their own below. The runtime properties they demonstrate (a token parking at
 * a catch, a boundary cancelling its host) need a real engine and are proven by
 * the Docker-gated e2e suites.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr, irToXml } from '@bpmn-script/transform';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROCESSES_DIR = resolve(__dirname, '../examples/spring-boot/processes');

const EXAMPLES = readdirSync(PROCESSES_DIR)
  .filter((file) => file.endsWith('.bpmnscript'))
  .sort();

// A directory-driven sweep that finds nothing would pass by asserting nothing.
if (EXAMPLES.length === 0) {
  throw new Error(`no .bpmnscript examples found under ${PROCESSES_DIR}`);
}

const sourceOf = (file: string): string =>
  readFileSync(resolve(PROCESSES_DIR, `${file}.bpmnscript`), 'utf-8');

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

/** The compiled BPMN XML of one example, failing on any parser error. */
async function compile(file: string): Promise<string> {
  const document = await parse(sourceOf(file));
  expect(document.parseResult.parserErrors).toEqual([]);
  return irToXml(astToIr(document.parseResult.value));
}

describe('every deployable example', () => {
  it.each(EXAMPLES)('%s opens validator-clean in the IDE', async (file) => {
    const { diagnostics } = await validate(
      readFileSync(resolve(PROCESSES_DIR, file), 'utf-8'),
    );
    expect(diagnostics).toEqual([]);
  });
});

describe('the awaiting-confirmation deployable example', () => {
  it('desugars the await into an intermediateCatchEvent node carrying the message definition', async () => {
    // Desugaring is what decides what an `await` lowers to, so XML inspection
    // alone would miss it.
    const document = await parse(sourceOf('awaiting-confirmation'));
    expect(document.parseResult.parserErrors).toEqual([]);

    const ir = astToIr(document.parseResult.value);
    const catchNode = ir.flowElements.find(
      (el) => el.kind === 'intermediateCatchEvent',
    );

    expect(catchNode).toBeDefined();
    expect(catchNode).toMatchObject({
      kind: 'intermediateCatchEvent',
      eventDefinition: {
        kind: 'message',
        messageName: 'ConfirmationReceived',
      },
    });
  });
});

describe('the order-handling deployable example', () => {
  it('compiles to BPMN XML with the expected attached boundary events', async () => {
    // The sub-process containment demo doubles as the boundary-event
    // walkthrough, and has no golden fixture of its own.
    const xml = await compile('order-handling');

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

describe('the charge-with-recovery deployable example', () => {
  it('compiles to BPMN XML with an interrupting error boundary on the charge service task', async () => {
    const xml = await compile('charge-with-recovery');

    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
    );
  });
});

describe('the compensating-saga deployable example', () => {
  it('compiles to BPMN XML with the undo handler wired over the compensable subprocess', async () => {
    // A completed compensable subprocess unwound from inside a process-level
    // error handler.
    const xml = await compile('compensating-saga');

    expect(xml).toContain(
      '<bpmn:subProcess id="ReserveSeat" name="Reserve the seat">',
    );
    expect(xml).toMatch(
      /<bpmn:subProcess id="EventSubProcess_compensating-saga_\d+(?:_\d+)?" triggeredByEvent="true">[\s\S]*?<bpmn:compensateEventDefinition \/>/,
    );
    expect(xml).toContain(
      '<bpmn:serviceTask id="ReleaseSeat" name="Release the seat" operaton:class="com.example.demo.LogDelegate">',
    );
  });
});
