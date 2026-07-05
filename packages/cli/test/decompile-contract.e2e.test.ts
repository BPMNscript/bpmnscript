/**
 * Feature end-to-end tests for the honest `xmlToIr` decompile contract and
 * the whole-process validator integrity checks — the final gate suite.
 *
 * Writes no implementation code: only exercises pre-existing entry points
 * (`xmlToIr`, `irToDsl`, the CLI's `parseAction`/`buildAction`, and the real
 * Langium validation pipeline via `createBpmnScriptServices`) against real
 * BPMN fixtures on disk. No mocks of the transform, no Docker.
 *
 * `decompileBpmnToDsl` (the VS Code extension's typed wrapper around
 * `xmlToIr`) is not reachable from this package — `packages/extension` is
 * not a dependency of `packages/cli`. `xmlToIr` itself (the real transform
 * `decompileBpmnToDsl` wraps, with zero behavioural difference for what this
 * suite asserts) plus the CLI's own `parseAction`/`buildAction` entry points
 * exercise the identical contract end-to-end, per the plan's "and/or spawn
 * the CLI" allowance — no separate subprocess spawn is needed since these
 * action functions already drive the full real pipeline (parse → validate →
 * transform → write to disk).
 *
 * Critical paths covered:
 *   1. Warning path (happy) — `tests/fixtures/lanes-and-async.bpmn` decompiles
 *      successfully and surfaces warnings naming both dropped items (a lane
 *      and an `operaton:asyncBefore` extension attribute) with their element
 *      ids, both via the real `xmlToIr` return value and via `parseAction`
 *      (stderr text + exit code 0).
 *   2. Refusal path (error) — `tests/fixtures/timer-start.bpmn` refuses
 *      loudly (`UnsupportedEventDefinitionError`, a subclass of
 *      `UnsupportedConstructError`), via `xmlToIr` directly and via
 *      `parseAction` (exit code 1, no partial output file).
 *   3. Integration — the warning-path fixture also exercises the
 *      pre-existing happy path (start → user task → end) alongside the new
 *      drop logic; the DSL produced from it re-parses with zero parser
 *      errors and re-compiles (via the CLI's `buildAction`, the same
 *      parse → validate → astToIr → irToXml pipeline `compileDslToBpmn`
 *      wraps) without any validation error.
 *   4. Language integrity — one DSL source that trips two whole-process
 *      validator checks at once (a duplicate process name and a `goto` into
 *      a `parallel` branch from outside) is run through the real
 *      `createBpmnScriptServices` validation pipeline; the resulting
 *      diagnostics are asserted for count, severity, and jargon-free
 *      wording.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import {
  xmlToIr,
  irToDsl,
  UnsupportedConstructError,
  UnsupportedEventDefinitionError,
} from '@bpmn-script/transform';

import { buildAction } from '../src/build.js';
import { parseAction } from '../src/parse.js';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the bpmnscript monorepo (three levels up from packages/cli/test/). */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const LANES_AND_ASYNC_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/lanes-and-async.bpmn',
);

const TIMER_START_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/timer-start.bpmn',
);

/** BPMN vocabulary the DSL author never sees (ADR-0013). */
const FORBIDDEN_JARGON = ['flow node', 'gateway', 'token', 'sequence flow'];

function assertNoForbiddenJargon(text: string): void {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN_JARGON) {
    expect(
      lower,
      `message must not use BPMN jargon "${word}": ${text}`,
    ).not.toContain(word);
  }
}

// ---------------------------------------------------------------------------
// Helpers (self-contained — mirrors packages/cli/test/build-parse.smoke.test.ts)
// ---------------------------------------------------------------------------

/** Sentinel error thrown by the mocked process.exit() stub. */
class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) was called`);
    this.name = 'ExitCalled';
  }
}

/**
 * Spy on `process.exit` and throw `ExitCalled` instead of terminating.
 * Returns the spy so the caller can inspect `.mock.calls`.
 */
function spyOnExit() {
  return vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : 0);
    });
}

/**
 * Run `fn` inside a temporary directory, cleaning up afterwards.
 *
 * @param fn Receives the absolute path to the temp directory.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-decompile-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shared Langium services (built once — expensive)
// ---------------------------------------------------------------------------

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

// ---------------------------------------------------------------------------
// 1. Warning path (happy): lanes + dropped extension attribute
// ---------------------------------------------------------------------------

describe('decompile contract — warning path (lanes + dropped extension attribute)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] xmlToIr decompiles the lanes-and-async fixture into the supported subset and surfaces one lane warning + one extension-attribute warning naming both dropped items and their element ids', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir, warnings } = await xmlToIr(xml);

    // The pre-existing happy-path subset (start → user task → end) is
    // preserved alongside the new drop logic.
    expect(ir.id).toBe('lanes-and-async');
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'userTask',
      'endEvent',
    ]);
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.kind === 'userTask' && task.assignee).toBe('demo');

    // Both non-semantic drops are surfaced — never silently.
    expect(warnings).toHaveLength(2);
    const laneWarning = warnings.find((w) => w.category === 'lane');
    expect(laneWarning?.elementId).toBe('Lane_Ops');

    const attrWarning = warnings.find(
      (w) => w.category === 'extensionAttribute',
    );
    expect(attrWarning?.elementId).toBe('ReviewRequest');
    expect(attrWarning?.message).toContain('asyncBefore');
  });

  it('[integration] parseAction on the lanes-and-async fixture writes the .bpmnscript file and prints both warnings to stderr without changing the exit code', async () => {
    await withTempDir(async (dir) => {
      const outDsl = path.join(dir, 'lanes-and-async.bpmnscript');
      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await parseAction(LANES_AND_ASYNC_BPMN, { output: outDsl });

      // Success path: process.exit must never be called (exit code stays 0).
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(outDsl)).toBe(true);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('Lane_Ops');
      expect(stderrOutput).toContain('asyncBefore');
      expect(stderrOutput).toContain('ReviewRequest');

      const dsl = fs.readFileSync(outDsl, 'utf-8');
      expect(dsl).toContain('process lanes-and-async');
      expect(dsl).toContain('start ReviewStart');
      expect(dsl).toContain('user ReviewRequest');
      expect(dsl).toContain('assignee = "demo"');
      expect(dsl).toContain('end ReviewDone');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Refusal path (error): timer start event
// ---------------------------------------------------------------------------

describe('decompile contract — refusal path (timer start event)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] xmlToIr refuses the timer-start fixture with UnsupportedEventDefinitionError (extends UnsupportedConstructError) naming the offending start event, with no BPMN jargon', async () => {
    const xml = fs.readFileSync(TIMER_START_BPMN, 'utf-8');

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedEventDefinitionError,
    );

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      const e = err as UnsupportedEventDefinitionError;
      expect(e.elementId).toBe('ScheduledStart');
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:TimerEventDefinition');
      expect(e.message).toContain('ScheduledStart');
      expect(e.message.toLowerCase()).toContain('timer');
      assertNoForbiddenJargon(e.message);
    }
  });

  it('[integration] parseAction on the timer-start fixture exits 1, writes no output file, and prints an actionable message naming the offending element', async () => {
    await withTempDir(async (dir) => {
      const outDsl = path.join(dir, 'timer-start.bpmnscript');
      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        parseAction(TIMER_START_BPMN, { output: outDsl }),
      ).rejects.toBeInstanceOf(ExitCalled);

      // Exit code 1 = unsupported construct, not 2 (I/O/generic).
      expect(exitSpy).toHaveBeenCalledWith(1);
      // No partial DSL is ever written.
      expect(fs.existsSync(outDsl)).toBe(false);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('ScheduledStart');
      expect(stderrOutput.toLowerCase()).toContain('timer');
      assertNoForbiddenJargon(stderrOutput);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Integration: decompiled output re-parses and re-compiles cleanly
// ---------------------------------------------------------------------------

describe('decompile contract — integration: decompiled DSL round-trips through the compile pipeline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] the DSL produced from the lanes-and-async fixture re-parses with zero parser errors and zero validation diagnostics', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir } = await xmlToIr(xml);
    const dsl = irToDsl(ir);

    const document = await parse(dsl, { validation: true });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const { diagnostics } = await validate(dsl);
    expect(diagnostics).toHaveLength(0);
  });

  it("[integration] the DSL produced from the lanes-and-async fixture re-compiles via buildAction (compileDslToBpmn's own pipeline) without validation errors, and the rebuilt BPMN re-imports cleanly", async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir } = await xmlToIr(xml);
    const dsl = irToDsl(ir);

    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'lanes-and-async.bpmnscript');
      const outBpmn = path.join(dir, 'lanes-and-async.bpmn');
      fs.writeFileSync(srcFile, dsl, 'utf-8');

      const exitSpy = spyOnExit();

      // buildAction runs the exact parse → validate → astToIr → irToXml
      // pipeline that compileDslToBpmn (packages/extension) wraps. No
      // validation error means no process.exit call.
      await buildAction(srcFile, { output: outBpmn });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(outBpmn)).toBe(true);

      // Full round-trip sanity: the rebuilt BPMN re-imports without throwing
      // and keeps the same process id.
      const rebuiltXml = fs.readFileSync(outBpmn, 'utf-8');
      const { ir: rebuiltIr } = await xmlToIr(rebuiltXml);
      expect(rebuiltIr.id).toBe('lanes-and-async');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Language integrity: multiple validator checks in one document
// ---------------------------------------------------------------------------

describe('decompile contract — language integrity: extra process + goto into a parallel branch', () => {
  it('a document tripping both checks yields exactly those two errors, each an error severity, with jargon-free wording', async () => {
    const source = `
process Flow {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
process Second {
  start S
  end E
}
`;

    const { document, diagnostics } = await validate(source);
    expect(document.parseResult.parserErrors).toHaveLength(0);

    // Exactly two diagnostics: no double-reporting, no stray warnings.
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.severity).toBe(1);
      assertNoForbiddenJargon(d.message);
    }

    const extraProcess = diagnostics.find((d) =>
      d.message.includes('Only one process is supported'),
    );
    expect(extraProcess).toBeDefined();

    const gotoIntoParallel = diagnostics.find((d) =>
      d.message.toLowerCase().includes('branch'),
    );
    expect(gotoIntoParallel?.message).toContain('A');
  });
});
