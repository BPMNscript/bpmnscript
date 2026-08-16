/**
 * Frozen forward golden + round-trip proof that a boundary handler attaches
 * cleanly to a script task and to a service task bound through its `topic`
 * attribute — the delegated-to-an-external-worker binding no other golden
 * covers.
 *
 * The fixture (`golden/boundary-task-hosts.bpmnscript`) is a checkout
 * narrative — charge the card, compute the shipping cost, print the label —
 * with one boundary handler on each step: an interrupting error boundary on
 * the class-bound service task (the flagship shape), a non-interrupting
 * (`alongside`) timer boundary on the script task, and an interrupting
 * message boundary on the topic-bound service task.
 *
 * Four cases, mirroring the structure of the other construct round-trip
 * suites (`boundary-events.round-trip.test.ts`, `intermediate-catch.round-trip.test.ts`):
 *
 *   1. Fixture health — the authored program validates with zero
 *      diagnostics.
 *   2. Golden generation — `irToXml(astToIr(parse(fixture)))` equals the
 *      frozen `.bpmn` byte-for-byte, with each host's `attachedToRef` pinned.
 *   3. Idempotence — importing the frozen golden and running it back through
 *      the decompiler and the desugarer produces an IR that is topologically
 *      identical to the one the fixture itself produces
 *      (`normalizeIr(IR₁) == normalizeIr(IR₃)`).
 *   4. Recompile-validity — the decompiled DSL′ re-opens with zero error
 *      diagnostics.
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
  FlowContainer,
  FlowElement,
} from '@bpmn-script/transform';

import { normalizeIr } from './helpers/normalize-ir.js';

// ---------------------------------------------------------------------------
// File-path resolution (mirrors boundary-events.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The boundary-on-task-host DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(
  __dirname,
  'golden/boundary-task-hosts.bpmnscript',
);

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/boundary-task-hosts.bpmn');

// ---------------------------------------------------------------------------
// Langium services — one shared instance for the whole suite.
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

/**
 * Parse DSL source into a checked AST. Throws (failing the test) if the source
 * has any parser error — a round-tripped source that does not re-parse is
 * itself a round-trip failure, so it must abort the test, never be swallowed.
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

type BoundaryEvent = Extract<FlowElement, { kind: 'boundaryEvent' }>;

/** Every boundary event directly inside a container, in document order. */
function boundaryEvents(container: FlowContainer): BoundaryEvent[] {
  return container.flowElements.filter(
    (fe): fe is BoundaryEvent => fe.kind === 'boundaryEvent',
  );
}

/**
 * A boundary event rendered as everything about it that is NOT its id: the
 * host it attaches to, the trigger kind, the caught payload, and whether it
 * cancels its host.
 */
function attachmentSignature(boundary: BoundaryEvent): string {
  const def = boundary.eventDefinition;
  const payload =
    def.kind === 'error'
      ? (def.errorCode ?? '<catch-all>')
      : def.kind === 'message'
        ? def.messageName
        : def.kind === 'timer'
          ? `${def.timerKind} ${def.expression}`
          : '<none>';
  const cancels =
    boundary.cancelActivity === false ? 'alongside' : 'interrupting';
  return `${boundary.attachedToRef} ${def.kind} ${payload} ${cancels}`;
}

/** Every boundary event's attachment signature in a container, sorted. */
function attachmentSignatures(container: FlowContainer): string[] {
  return boundaryEvents(container).map(attachmentSignature).sort();
}

/**
 * The three boundary events the fixture authors, one per task host kind, as
 * attachment signatures. Frozen here so a hop that silently drops a host,
 * flips `cancelActivity`, or loses a trigger payload fails with a readable
 * diff rather than a deep-equality dump.
 */
const EXPECTED_ATTACHMENTS = [
  'ChargeCard error PAYMENT_DECLINED interrupting',
  'ComputeShipping timer duration PT1H alongside',
  'PrintLabel message ExpediteRequested interrupting',
].sort();

// ---------------------------------------------------------------------------
// Pipeline — run once in beforeAll; each test makes focused assertions.
// ---------------------------------------------------------------------------

let fixtureSrc: string;
let frozenXml: string;
let generatedXml: string; // irToXml(astToIr(parse(fixture)))
let ir1: BpmnProcess; // astToIr(parse(fixture))
let ir3: BpmnProcess; // re-desugared after DSL → XML → DSL′
let dslPrime: string; // decompiled DSL after importing the frozen golden

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);

  fixtureSrc = readFileSync(FIXTURE_PATH, 'utf-8');
  frozenXml = readFileSync(FROZEN_BPMN_PATH, 'utf-8');

  ir1 = astToIr(await parseToAst(fixtureSrc));
  generatedXml = await irToXml(ir1);

  const { ir: imported } = await xmlToIr(frozenXml);
  dslPrime = irToDsl(imported);
  ir3 = astToIr(await parseToAst(dslPrime));
});

// ===========================================================================
// Authored-program health: the fixture opens validator-clean.
// ===========================================================================

describe('the authored program opens validator-clean', () => {
  it('the fixture produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(fixtureSrc);
    expect(diagnostics).toEqual([]);
  });
});

// ===========================================================================
// 1. Golden generation.
// ===========================================================================

describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
  it('irToXml(astToIr(parse(fixture))) equals the frozen artifact byte-for-byte', () => {
    expect(generatedXml).toBe(frozenXml);
  });

  it('each host carries its boundary event, pinned by attachedToRef', () => {
    expect(generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ChargeCard_error" attachedToRef="ChargeCard">',
    );
    expect(generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_ComputeShipping_timer" cancelActivity="false" attachedToRef="ComputeShipping">',
    );
    expect(generatedXml).toContain(
      '<bpmn:boundaryEvent id="Boundary_PrintLabel_message" attachedToRef="PrintLabel">',
    );
  });
});

// ===========================================================================
// 2. Idempotence.
// ===========================================================================

describe('idempotence: golden .bpmn → IR₂ → DSL′ → IR₃', () => {
  it('normalizeIr(IR₁) equals normalizeIr(IR₃)', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('the restructured DSL′ re-parses with zero parser errors', async () => {
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it("each boundary's host, trigger, payload, and cancelActivity survive the round-trip", () => {
    expect(attachmentSignatures(ir1)).toEqual(EXPECTED_ATTACHMENTS);
    expect(attachmentSignatures(ir3)).toEqual(EXPECTED_ATTACHMENTS);
  });
});

// ===========================================================================
// 3. Recompile-validity.
// ===========================================================================

describe('recompile-validity: the decompiled DSL′ recompiles clean', () => {
  it('the decompiled DSL′ validates with zero error diagnostics', async () => {
    const { diagnostics } = await validate(dslPrime);
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});
