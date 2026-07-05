/**
 * Smoke tests for the CLI `build` and `parse` actions.
 *
 * These are integration tests: they exercise the full pipeline end-to-end
 * using real files, real Langium services, and real transforms. No mocks.
 *
 * Test matrix:
 *  1. buildAction(invoice-approval.bpmnscript) → .bpmn file; xmlToIr of the
 *     output does not throw; process key is `invoice-approval`.
 *  2. parseAction(invoice-approval-generated.bpmn) → .bpmnscript file;
 *     re-parsing yields zero errors.
 *  3. Severity-gating regression:
 *     a. A source with an undeclared-variable WARNING builds successfully.
 *     b. A source with a type-mismatch ERROR fails the build.
 *  4. tmLanguage copy: extension/syntaxes/ matches language/syntaxes/ and
 *     the extension's `build:prepare` script performs the copy.
 *  5. Import-warning surfacing: parsing a BPMN with dropped non-semantic
 *     content (extension attribute + lane) prints warning text and the
 *     owning element id to stderr, and does not fail (no process.exit call).
 *  6. Refusal classification: parsing a BPMN with a refused construct (a
 *     timer start event) exits with code 1 and prints an actionable message
 *     naming the offending element; no output file is written.
 *
 * NOTE on process.exit interception:
 *   `buildAction` / `parseAction` call `process.exit()` directly. To avoid
 *   terminating the test process, we spy on `process.exit` and replace it with
 *   a throwing stub. We restore the original after each test. `vi.spyOn` with
 *   `mockImplementation` is the correct mechanism here — the spy records the
 *   exit code so we can assert on it.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import { buildAction } from '../src/build.js';
import { parseAction } from '../src/parse.js';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the bpmnscript monorepo (four levels up from packages/cli/test/). */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const LANGUAGE_TMLANGUAGE = path.resolve(
  REPO_ROOT,
  'packages/language/syntaxes/bpmn-script.tmLanguage.json',
);

const EXTENSION_TMLANGUAGE = path.resolve(
  REPO_ROOT,
  'packages/extension/syntaxes/bpmn-script.tmLanguage.json',
);

// ---------------------------------------------------------------------------
// Helpers
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
 * @param fn  Receives the absolute path to the temp directory.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-smoke-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Suite 1 — buildAction smoke
// ---------------------------------------------------------------------------

describe('buildAction smoke', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] builds invoice-approval.bpmnscript; output re-imports via xmlToIr with process key invoice-approval', async () => {
    await withTempDir(async (dir) => {
      const outBpmn = path.join(dir, 'invoice-approval.bpmn');
      const exitSpy = spyOnExit();

      // buildAction should succeed (no exit call expected).
      await buildAction(INVOICE_APPROVAL_SRC, { output: outBpmn });

      // Verify process.exit was NOT called.
      expect(exitSpy).not.toHaveBeenCalled();

      // Output file must exist.
      expect(fs.existsSync(outBpmn)).toBe(true);

      // Output must be valid BPMN that xmlToIr can import without throwing.
      const xml = fs.readFileSync(outBpmn, 'utf-8');
      let ir;
      try {
        ({ ir } = await xmlToIr(xml));
      } catch (e) {
        throw new Error(
          `xmlToIr threw on the built output: ${(e as Error).message}`,
        );
      }

      // Process key must match the one the E2E uses to start the process.
      expect(ir.id).toBe('invoice-approval');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — parseAction smoke
// ---------------------------------------------------------------------------

describe('parseAction smoke', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] parses invoice-approval-generated.bpmn; re-parsing the emitted DSL yields zero parser errors', async () => {
    await withTempDir(async (dir) => {
      const outDsl = path.join(dir, 'invoice-approval.bpmnscript');
      const exitSpy = spyOnExit();

      // parseAction should succeed (no exit call expected).
      await parseAction(GOLDEN_GENERATED_BPMN, { output: outDsl });

      // Verify process.exit was NOT called.
      expect(exitSpy).not.toHaveBeenCalled();

      // Output file must exist.
      expect(fs.existsSync(outDsl)).toBe(true);

      // Re-parse the emitted DSL via Langium; expect zero parser errors.
      const dsl = fs.readFileSync(outDsl, 'utf-8');
      const doc = await parse(dsl);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2b — parseAction: import-warning surfacing (non-fatal)
// ---------------------------------------------------------------------------

/**
 * A BPMN process whose only supported subset is start → user task → end, but
 * the task carries a dropped Operaton extension attribute (`asyncBefore`,
 * beyond the supported assignee/formKey/class set) and the process defines a
 * lane. Both are non-semantic drops: `xmlToIr` warns instead of refusing.
 */
const LANE_AND_ASYNC_ATTR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="warns" isExecutable="true">
    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Ops" name="Ops">
        <bpmn:flowNodeRef>S</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>AsyncTask</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>E</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="AsyncTask" name="Async Task"
                   operaton:assignee="alice" operaton:asyncBefore="true" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseAction — import-warning surfacing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] a dropped extension attribute and a lane print warning text + element id to stderr and do not fail the parse', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'warns.bpmn');
      const outDsl = path.join(dir, 'warns.bpmnscript');
      fs.writeFileSync(srcFile, LANE_AND_ASYNC_ATTR_BPMN, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await parseAction(srcFile, { output: outDsl });

      // Success path: process.exit must never be called; exit code stays 0.
      expect(exitSpy).not.toHaveBeenCalled();

      // The parse still succeeds — the output file is written.
      expect(fs.existsSync(outDsl)).toBe(true);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');

      // The extension-attribute warning names the concrete attribute and its
      // owning element id.
      expect(stderrOutput).toContain('asyncBefore');
      expect(stderrOutput).toContain('AsyncTask');

      // The lane warning names its element id.
      expect(stderrOutput).toContain('Lane_Ops');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2c — parseAction: refused-construct classification
// ---------------------------------------------------------------------------

/** A start event with a timer definition — refused via UnsupportedEventDefinitionError. */
const TIMER_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="timer" isExecutable="true">
    <bpmn:startEvent id="TimerStart">
      <bpmn:timerEventDefinition id="td">
        <bpmn:timeDuration>PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="TimerStart" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseAction — refused-construct classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] a timer start event refuses loudly with exit code 1, an actionable message, and no output file', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'timer.bpmn');
      const outDsl = path.join(dir, 'timer.bpmnscript');
      fs.writeFileSync(srcFile, TIMER_START_BPMN, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        parseAction(srcFile, { output: outDsl }),
      ).rejects.toBeInstanceOf(ExitCalled);

      // Exit code 1 = unsupported construct, not 2 (I/O/generic).
      expect(exitSpy).toHaveBeenCalledWith(1);

      // No partial output written.
      expect(fs.existsSync(outDsl)).toBe(false);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('TimerStart');
      expect(stderrOutput).toContain('timer');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — severity-gating regression
// ---------------------------------------------------------------------------

/**
 * A minimal valid BPMNscript that uses `amount` without declaring it.
 * The validator emits an undeclared-variable WARNING (severity 2).
 * `build.ts` must NOT treat this as a build failure.
 */
const WARNING_ONLY_SOURCE = `process warning-only {
  start S
  if (amount > 1000) {
    service DoSomething { class = "com.example.Delegate" }
  } else {
    end A
  }
  end Done
}
`;

/**
 * A minimal BPMNscript that declares `amount` as `string` and uses it in a
 * numeric comparison. The validator emits a type-mismatch ERROR (severity 1).
 * `build.ts` MUST exit with code 1.
 */
const TYPE_MISMATCH_SOURCE = `process type-mismatch {
  var amount: string
  start S
  if (amount > 1000) {
    end A
  } else {
    end B
  }
}
`;

describe('severity-gating regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[integration] warning-only source (undeclared variable) builds successfully (exit 0 path)', async () => {
    await withTempDir(async (dir) => {
      // Write the fixture source to a temp file with the correct extension.
      const srcFile = path.join(dir, 'warning-only.bpmnscript');
      const outBpmn = path.join(dir, 'warning-only.bpmn');
      fs.writeFileSync(srcFile, WARNING_ONLY_SOURCE, 'utf-8');

      const exitSpy = spyOnExit();

      // Must NOT throw (no ExitCalled), because the warning does not fail.
      await expect(
        buildAction(srcFile, { output: outBpmn }),
      ).resolves.toBeUndefined();

      // process.exit must NOT have been called at all.
      expect(exitSpy).not.toHaveBeenCalled();

      // The output file must be written.
      expect(fs.existsSync(outBpmn)).toBe(true);
    });
  });

  it('[integration] type-mismatch error source fails the build (exit 1 path)', async () => {
    await withTempDir(async (dir) => {
      // Write the fixture source to a temp file with the correct extension.
      const srcFile = path.join(dir, 'type-mismatch.bpmnscript');
      const outBpmn = path.join(dir, 'type-mismatch.bpmn');
      fs.writeFileSync(srcFile, TYPE_MISMATCH_SOURCE, 'utf-8');

      const exitSpy = spyOnExit();

      // The action must call process.exit(1), which our spy converts to ExitCalled.
      await expect(
        buildAction(srcFile, { output: outBpmn }),
      ).rejects.toBeInstanceOf(ExitCalled);

      // Assert exit code is 1 (validation error), not 2 (I/O error).
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — tmLanguage copy check
// ---------------------------------------------------------------------------

describe('tmLanguage extension sync', () => {
  it('[unit] extension/syntaxes/ tmLanguage.json matches language/syntaxes/ (not stale)', () => {
    // Both files must exist.
    expect(
      fs.existsSync(LANGUAGE_TMLANGUAGE),
      `language tmLanguage not found at ${LANGUAGE_TMLANGUAGE}`,
    ).toBe(true);
    expect(
      fs.existsSync(EXTENSION_TMLANGUAGE),
      `extension tmLanguage not found at ${EXTENSION_TMLANGUAGE}`,
    ).toBe(true);

    const languageContent = fs.readFileSync(LANGUAGE_TMLANGUAGE, 'utf-8');
    const extensionContent = fs.readFileSync(EXTENSION_TMLANGUAGE, 'utf-8');

    expect(extensionContent).toBe(languageContent);
  });

  it('[unit] extension package.json has a build:prepare script that copies the tmLanguage', () => {
    const extensionPkgJson = path.resolve(
      REPO_ROOT,
      'packages/extension/package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(extensionPkgJson, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const preparescript = pkg.scripts?.['build:prepare'] ?? '';

    // Must reference both the source (language/syntaxes) and destination (./syntaxes/).
    expect(
      preparescript,
      'build:prepare must mention language/syntaxes',
    ).toContain('language/syntaxes');
    expect(preparescript, 'build:prepare must mention ./syntaxes/').toContain(
      'syntaxes',
    );

    // Must be a cp command (shx cp or cp).
    expect(preparescript, 'build:prepare must perform a file copy').toMatch(
      /\bcp\b/,
    );
  });
});
