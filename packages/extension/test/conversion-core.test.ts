/**
 * Integration and unit tests for the conversion core module.
 *
 * Tests cover the full DSL→BPMN compile path, the BPMN→DSL decompile path,
 * severity gating (warnings do not block compilation), unsupported-construct
 * rejection, and the output-path helper.
 *
 * All test-N (integration) tests drive real Langium services and real
 * transform functions — no mocks, no disk writes. Fixtures are read from
 * the repository using a REPO_ROOT anchored from this file's URL.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from '../src/extension/conversion-core.js';

// ---------------------------------------------------------------------------
// Path resolution — mirrors cli/test/build-parse.smoke.test.ts
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the bpmnscript monorepo (three levels up from packages/extension/test/). */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-expression.bpmn',
);

// Verify fixtures exist at module load time to surface path errors early.
for (const [label, p] of [
  ['invoice-approval.bpmnscript', INVOICE_APPROVAL_SRC],
  ['invoice-approval-generated.bpmn', GOLDEN_GENERATED_BPMN],
  ['bad-service-task-expression.bpmn', BAD_SERVICE_TASK_BPMN],
] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture not found: ${label} at ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Suite 1 — compileDslToBpmn: happy path (golden fixture)
// ---------------------------------------------------------------------------

describe('[integration] compileDslToBpmn — invoice-approval golden fixture', () => {
  it('compiles to ok:true; output contains bpmn:definitions; re-imports via xmlToIr with process id invoice-approval', async () => {
    const source = fs.readFileSync(INVOICE_APPROVAL_SRC, 'utf-8');

    const result = await compileDslToBpmn(
      source,
      'invoice-approval.bpmnscript',
      '0.0.1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type for TypeScript

    // Output must be a BPMN XML string with the definitions root element.
    expect(result.output).toContain('bpmn:definitions');

    // Re-importing via xmlToIr must not throw and must yield the correct process id.
    const ir = await xmlToIr(result.output);
    expect(ir.id).toBe('invoice-approval');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — compileDslToBpmn: validation error gate
// ---------------------------------------------------------------------------

describe('[integration] compileDslToBpmn — type-mismatch validation error', () => {
  it('returns ok:false, kind:validation, diagnostics.length >= 1, each with 0-based line and non-empty message', async () => {
    // `name` is declared as `string` but compared to a number — type-mismatch ERROR.
    const source = `process p {
  var name: string
  if (name > 1000) { user A }
}
`;

    const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.kind).toBe('validation');
    if (result.kind !== 'validation') return;

    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);

    for (const d of result.diagnostics) {
      // 0-based line numbers (LSP convention).
      expect(d.line).toBeGreaterThanOrEqual(0);
      // Non-empty message.
      expect(d.message.length).toBeGreaterThan(0);
      // Severity must be 1 (Error) — warnings do not block, so they are filtered out.
      expect(d.severity).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — compileDslToBpmn: severity gating — warnings do not block
// ---------------------------------------------------------------------------

describe('[integration] compileDslToBpmn — undeclared-variable warning does not block', () => {
  it('returns ok:true for a source whose only diagnostic is an undeclared-variable warning', async () => {
    // `amount` is used without being declared: undeclared-variable WARNING (severity 2).
    // Warnings must NOT prevent compilation — only severity 1 (Error) diagnostics block.
    const source = `process p { if (amount > 1000) { user A } }`;

    const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Output must be a non-empty BPMN XML string.
      expect(result.output.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — decompileBpmnToDsl: happy path (golden fixture)
// ---------------------------------------------------------------------------

describe('[integration] decompileBpmnToDsl — invoice-approval-generated golden fixture', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it('returns ok:true; output re-parses through Langium with zero parser errors', async () => {
    const xml = fs.readFileSync(GOLDEN_GENERATED_BPMN, 'utf-8');

    const result = await decompileBpmnToDsl(xml, 'invoice-approval-generated.bpmn');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The emitted DSL must re-parse without parser errors.
    const doc = await parse(result.output);
    expect(doc.parseResult.parserErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — decompileBpmnToDsl: unsupported construct rejection
// ---------------------------------------------------------------------------

describe('[integration] decompileBpmnToDsl — bad-service-task-expression.bpmn', () => {
  it('returns ok:false, kind:unsupported; message mentions operaton:expression and BadService_1', async () => {
    const xml = fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8');

    const result = await decompileBpmnToDsl(xml, 'bad-service-task-expression.bpmn');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;

    // The error message must identify both the offending construct and the task id.
    expect(result.message).toContain('BadService_1');
    expect(result.message).toContain('operaton:expression');
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — swapExtension: pure helper
// ---------------------------------------------------------------------------

describe('[unit] swapExtension', () => {
  it('strips the final extension and appends the new one, preserving dotted basenames', () => {
    expect(swapExtension('/a/b/my.invoice.bpmnscript', '.bpmn')).toBe(
      '/a/b/my.invoice.bpmn',
    );
  });

  it('swaps .bpmn to .bpmnscript', () => {
    expect(swapExtension('/a/b/x.bpmn', '.bpmnscript')).toBe(
      '/a/b/x.bpmnscript',
    );
  });
});
