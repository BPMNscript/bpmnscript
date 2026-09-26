// Directory-driven rather than a hand-kept list, so a new example is covered the
// moment it lands. The last block pins the lowered shape of the examples that
// double as walkthroughs: the round-trip block alone would pass an `await`
// lowered to a receive task just as cleanly.

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

async function compile(file: string): Promise<string> {
  return irToXml(astToIr(await parseToAst(sourceOf(file))));
}

describe('every deployable example', () => {
  it.each(EXAMPLES)('%s opens validator-clean in the IDE', async (file) => {
    const { diagnostics } = await validate(
      readFileSync(resolve(PROCESSES_DIR, file), 'utf-8'),
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("every example round-trips through the tool's own output without a word", () => {
  it.each(EXAMPLES)('%s', async (file) => {
    const ir1 = astToIr(
      await parseToAst(readFileSync(resolve(PROCESSES_DIR, file), 'utf-8')),
    );

    const xml1 = await irToXml(ir1);
    const { ir: ir2, warnings: importWarnings } = await xmlToIr(xml1);
    const { source: dslPrime, warnings: printWarnings } = irToDsl(ir2);
    const ir3 = astToIr(await parseToAst(dslPrime));
    const { diagnostics } = await validate(dslPrime);

    // Mapped so a failure names the id and the message, not a range.
    expect({
      importWarnings: importWarnings.map((w) => ({
        elementId: w.elementId,
        category: w.category,
      })),
      printWarnings: printWarnings.map((w) => ({
        elementId: w.elementId,
        category: w.category,
      })),
      dslPrimeDiagnostics: diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
      })),
    }).toEqual({
      importWarnings: [],
      printWarnings: [],
      dslPrimeDiagnostics: [],
    });

    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });
});

describe('construct shapes pinned only by a deployable example', () => {
  it('awaiting-confirmation desugars the await into an intermediateCatchEvent carrying the message definition', async () => {
    const ir = astToIr(await parseToAst(sourceOf('awaiting-confirmation')));
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

  it('order-handling compiles to BPMN XML with the expected attached boundary events', async () => {
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

  it('charge-with-recovery compiles with an interrupting error boundary on the charge service task', async () => {
    const xml = await compile('charge-with-recovery');

    expect(xml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
    );
  });

  it('compensating-saga compiles with the undo handler wired over the compensable subprocess', async () => {
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
