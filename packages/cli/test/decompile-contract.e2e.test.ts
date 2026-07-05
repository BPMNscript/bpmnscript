/**
 * End-to-end tests for the CLI's decompile behaviour: `xmlToIr` / `irToDsl`
 * and the `parseAction`/`buildAction` entry points, driven against real BPMN
 * fixtures on disk with no mocks of the transform and no Docker.
 *
 * Covers: decompiling a BPMN with non-semantic drops (a lane, a dropped
 * Operaton extension attribute) and surfacing both as warnings with element
 * ids, via `xmlToIr` directly and via `parseAction`'s stderr output; refusing
 * a BPMN with an unsupported construct (a timer start event) with exit code 1
 * and no partial output file; round-tripping the decompiled DSL back through
 * `buildAction` without validation errors; and whole-process validator
 * diagnostics (duplicate process name, `goto` into a `parallel` branch from
 * outside) for count, severity, and jargon-free wording.
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

  it('xmlToIr decompiles the lanes-and-async fixture into the supported subset and surfaces one lane warning + one extension-attribute warning naming both dropped items and their element ids', async () => {
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

  it('parseAction on the lanes-and-async fixture writes the .bpmnscript file and prints both warnings to stderr without changing the exit code', async () => {
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

  it('xmlToIr refuses the timer-start fixture with UnsupportedEventDefinitionError (extends UnsupportedConstructError) naming the offending start event, with no BPMN jargon', async () => {
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

  it('parseAction on the timer-start fixture exits 1, writes no output file, and prints an actionable message naming the offending element', async () => {
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

  it('the DSL produced from the lanes-and-async fixture re-parses with zero parser errors and zero validation diagnostics', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir } = await xmlToIr(xml);
    const dsl = irToDsl(ir);

    const document = await parse(dsl, { validation: true });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const { diagnostics } = await validate(dsl);
    expect(diagnostics).toHaveLength(0);
  });

  it("the DSL produced from the lanes-and-async fixture re-compiles via buildAction (compileDslToBpmn's own pipeline) without validation errors, and the rebuilt BPMN re-imports cleanly", async () => {
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
