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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

const LANES_AND_ASYNC_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/lanes-and-async.bpmn',
);

const TIMER_START_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/timer-start.bpmn',
);

// BPMN vocabulary the DSL author never sees (ADR-0013).
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

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) was called`);
    this.name = 'ExitCalled';
  }
}

// Throws so the action stops where process.exit() would have. A no-op mock
// would let it fall through and keep running.
function spyOnExit() {
  return vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : 0);
    });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-decompile-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

describe('decompile contract — warning path (lanes + dropped extension attribute)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('xmlToIr decompiles the lanes-and-async fixture into the supported subset, keeps the engine setting the IR carries, and surfaces one lane warning + one extension warning naming the one genuinely dropped item', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir, warnings } = await xmlToIr(xml);

    expect(ir.id).toBe('lanes-and-async');
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'userTask',
      'endEvent',
    ]);
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.kind === 'userTask' && task.assignee).toBe('demo');
    expect(task?.kind === 'userTask' && task.asyncBefore).toBe(true);

    expect(warnings).toHaveLength(2);
    const laneWarning = warnings.find((w) => w.category === 'lane');
    expect(laneWarning?.elementId).toBe('Lane_Ops');

    const attrWarning = warnings.find(
      (w) => w.category === 'extensionAttribute',
    );
    // moddle cannot tie an undeclared operaton: element to a step, so the
    // warning lands on the process rather than on the task that carries it.
    expect(attrWarning?.elementId).toBe('lanes-and-async');
    expect(attrWarning?.message).toContain('operaton:properties');
  });

  it('parseAction on the lanes-and-async fixture writes the .bpmnscript file and prints both warnings to stderr without changing the exit code', async () => {
    await withTempDir(async (dir) => {
      const outDsl = path.join(dir, 'lanes-and-async.bpmnscript');
      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await parseAction(LANES_AND_ASYNC_BPMN, { output: outDsl });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(outDsl)).toBe(true);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('Lane_Ops');
      expect(stderrOutput).toContain('operaton:properties');

      const dsl = fs.readFileSync(outDsl, 'utf-8');
      expect(dsl).toContain('process lanes-and-async');
      expect(dsl).toContain('start ReviewStart');
      expect(dsl).toContain('user ReviewRequest');
      expect(dsl).toContain('assignee = "demo"');
      expect(dsl).toContain('end ReviewDone');
    });
  });
});

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

      // 1 means unsupported construct; 2 would mean I/O or generic failure.
      expect(exitSpy).toHaveBeenCalledWith(1);
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

      await buildAction(srcFile, { output: outBpmn });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(outBpmn)).toBe(true);

      const rebuiltXml = fs.readFileSync(outBpmn, 'utf-8');
      const { ir: rebuiltIr } = await xmlToIr(rebuiltXml);
      expect(rebuiltIr.id).toBe('lanes-and-async');
    });
  });
});

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
