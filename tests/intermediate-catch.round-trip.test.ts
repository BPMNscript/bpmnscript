/**
 * Frozen forward golden + round-trip proof for the intermediate catch event
 * (`await <trigger> …`) — the blocking, in-flow wait that pauses the token
 * until a message, timer, signal, or condition fires, then falls through to
 * the next step on the main sequence flow.
 *
 * The fixture (`golden/intermediate-catch.bpmnscript`) exercises all four
 * catchable triggers back to back on one main flow — `start` → a task →
 * `await message …` → `await timer after …` → `await signal …` →
 * `await condition (…)` → a task → `end` — so the frozen `.bpmn` covers every
 * payload shape (message name, timer duration, signal name, and a rendered
 * boolean expression) in a single artifact.
 *
 * Three cases, mirroring the structure of the other construct round-trip
 * suites (`event-triggers.round-trip.test.ts`, `boundary-events.round-trip.test.ts`):
 *
 *   1. Golden generation — `irToXml(astToIr(parse(fixture)))` equals the
 *      frozen `.bpmn` byte-for-byte.
 *   2. Idempotence — importing the frozen golden and running it back through
 *      the decompiler and the desugarer produces an IR that is
 *      topologically identical to the one the fixture itself produces
 *      (`normalizeIr(IR₁) == normalizeIr(IR₃)`); each catch keeps its
 *      trigger and payload, in order, at every hop.
 *   3. Recompile-validity — the decompiled DSL′ re-opens with zero error
 *      diagnostics, so an author editing the decompiled source is never
 *      greeted with an unreadable program.
 *
 * A fixture health check closes the suite: the authored fixture itself opens
 * validator-clean.
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
// File-path resolution (mirrors event-triggers.round-trip.test.ts).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The intermediate-catch DSL fixture (the pipeline input). */
const FIXTURE_PATH = resolve(__dirname, 'golden/intermediate-catch.bpmnscript');

/** The frozen full-pipeline output (`irToXml(astToIr(parse(fixture)))`). */
const FROZEN_BPMN_PATH = resolve(__dirname, 'golden/intermediate-catch.bpmn');

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

type IntermediateCatchEvent = Extract<
  FlowElement,
  { kind: 'intermediateCatchEvent' }
>;

/** Every intermediate catch event directly inside a container, in document order. */
function catchEvents(container: FlowContainer): IntermediateCatchEvent[] {
  return container.flowElements.filter(
    (fe): fe is IntermediateCatchEvent => fe.kind === 'intermediateCatchEvent',
  );
}

/**
 * A catch rendered as its trigger and payload — everything about it that is
 * NOT its id, since the surface carries no name slot and the id is always
 * the synthesized `Catch_<coord>_<index>`.
 */
function triggerSignature(catchEvent: IntermediateCatchEvent): string {
  const def = catchEvent.eventDefinition;
  switch (def.kind) {
    case 'message':
      return `message ${def.messageName}`;
    case 'signal':
      return `signal ${def.signalName}`;
    case 'timer':
      return `timer ${def.timerKind} ${def.expression}`;
    case 'conditional':
      return `condition ${def.condition}`;
  }
}

/** Every catch's trigger signature in a container, in document order. */
function triggerSignatures(container: FlowContainer): string[] {
  return catchEvents(container).map(triggerSignature);
}

/**
 * The four triggers the fixture awaits, in the order the main flow awaits
 * them. Frozen here so a hop that drops a catch, reorders it, or loses its
 * payload fails with a readable diff rather than a deep-equality dump.
 */
const EXPECTED_TRIGGERS = [
  'message PaymentConfirmed',
  'timer duration PT1H',
  'signal StockReplenished',
  'condition ${amount > 100}',
];

// ---------------------------------------------------------------------------
// Pipeline — run once in beforeAll; each test makes focused assertions.
// ---------------------------------------------------------------------------

let fixtureSrc: string;
let frozenXml: string;
let generatedXml: string; // irToXml(astToIr(parse(fixture)))
let ir1: BpmnProcess; // astToIr(parse(fixture))
let ir2: BpmnProcess; // xmlToIr(frozen golden) — the imported IR
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
  ir2 = imported;
  dslPrime = irToDsl(ir2);
  ir3 = astToIr(await parseToAst(dslPrime));
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

describe('idempotence: golden .bpmn → IR₂ → DSL′ → IR₃', () => {
  it('normalizeIr(IR₁) equals normalizeIr(IR₃)', () => {
    expect(normalizeIr(ir3)).toEqual(normalizeIr(ir1));
  });

  it('the restructured DSL′ re-parses with zero parser errors', async () => {
    const document = await parse(dslPrime);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });

  it('every catch keeps its trigger and payload, in order, at every hop', () => {
    for (const [label, ir] of [
      ['IR₁', ir1],
      ['IR₂', ir2],
      ['IR₃', ir3],
    ] as const) {
      expect(triggerSignatures(ir), `triggers differ in ${label}`).toEqual(
        EXPECTED_TRIGGERS,
      );
    }
  });

  it('no synthesized Catch_ id token leaks into the decompiled source', () => {
    // There is no authored name slot on `await`, so the decompiler must never
    // print the synthesized goto-target id — only the trigger and its payload.
    expect(dslPrime).not.toMatch(/Catch_/);
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

// ===========================================================================
// Authored-program health: the fixture opens validator-clean.
// ===========================================================================

describe('the authored program opens validator-clean', () => {
  it('the fixture produces no diagnostics at all', async () => {
    const { diagnostics } = await validate(fixtureSrc);
    expect(diagnostics).toEqual([]);
  });
});
