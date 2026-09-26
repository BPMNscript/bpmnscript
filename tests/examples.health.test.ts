// The last block pins lowered shapes the round trip alone would accept, such as
// an `await` lowered to a receive task.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { astToIr, irToDsl, irToXml, xmlToIr } from '@bpmn-script/transform';

import { parseToAst, validate } from './helpers/pipeline.js';
import { normalizeIr } from './helpers/normalize-ir.js';

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

describe('every deployable example', () => {
  it.each(EXAMPLES)(
    '%s is validator-clean and round-trips through its own output without a word',
    async (file) => {
      const source = readFileSync(resolve(PROCESSES_DIR, file), 'utf-8');
      const ir1 = astToIr(await parseToAst(source));
      const { ir: ir2, warnings: importWarnings } = await xmlToIr(
        await irToXml(ir1),
      );
      const { source: dslPrime, warnings: printWarnings } = irToDsl(ir2);
      const ir3 = astToIr(await parseToAst(dslPrime));

      // Mapped so a failure names the id and the message, not a range.
      const messages = async (dsl: string) =>
        (await validate(dsl)).diagnostics.map((d) => ({
          severity: d.severity,
          message: d.message,
        }));
      const categories = (ws: { elementId?: string; category: string }[]) =>
        ws.map((w) => ({ elementId: w.elementId, category: w.category }));
      expect({
        sourceDiagnostics: await messages(source),
        importWarnings: categories(importWarnings),
        printWarnings: categories(printWarnings),
        dslPrimeDiagnostics: await messages(dslPrime),
      }).toEqual({
        sourceDiagnostics: [],
        importWarnings: [],
        printWarnings: [],
        dslPrimeDiagnostics: [],
      });
      expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
    },
  );
});

describe('construct shapes pinned only by a deployable example', () => {
  it('awaiting-confirmation desugars the await into an intermediateCatchEvent carrying the message definition', async () => {
    const ir = astToIr(await parseToAst(sourceOf('awaiting-confirmation')));
    expect(
      ir.flowElements.find((el) => el.kind === 'intermediateCatchEvent'),
    ).toMatchObject({
      kind: 'intermediateCatchEvent',
      eventDefinition: { kind: 'message', messageName: 'ConfirmationReceived' },
    });
  });

  it.each([
    [
      'order-handling',
      'the attached boundary events',
      [
        '<bpmn:boundaryEvent id="Boundary_ReviewOrder_timer" cancelActivity="false" attachedToRef="ReviewOrder">',
        '<bpmn:boundaryEvent id="Boundary_ReviewOrder_message" attachedToRef="ReviewOrder">',
        '<bpmn:boundaryEvent id="Boundary_ReviewOrder_message_2" cancelActivity="false" attachedToRef="ReviewOrder">',
        '<bpmn:boundaryEvent id="Boundary_Payment_error" attachedToRef="Payment">',
        '<bpmn:boundaryEvent id="Boundary_Payment_escalation" cancelActivity="false" attachedToRef="Payment">',
      ],
    ],
    [
      'charge-with-recovery',
      'an interrupting error boundary on the charge service task',
      [
        '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
      ],
    ],
    [
      'compensating-saga',
      'the undo handler wired over the compensable subprocess',
      [
        '<bpmn:subProcess id="ReserveSeat" name="Reserve the seat">',
        /<bpmn:subProcess id="EventSubProcess_compensating-saga_\d+(?:_\d+)?" triggeredByEvent="true">[\s\S]*?<bpmn:compensateEventDefinition \/>/,
        '<bpmn:serviceTask id="ReleaseSeat" name="Release the seat" operaton:class="com.example.demo.LogDelegate">',
      ],
    ],
  ])('%s compiles with %s', async (file, _what, fragments) => {
    const xml = await irToXml(astToIr(await parseToAst(sourceOf(file))));
    for (const fragment of fragments) expect(xml).toMatch(fragment);
  });
});
