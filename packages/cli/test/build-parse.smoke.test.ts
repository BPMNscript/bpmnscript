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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-smoke-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('buildAction smoke', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds invoice-approval.bpmnscript; output re-imports via xmlToIr with process key invoice-approval', async () => {
    await withTempDir(async (dir) => {
      const outBpmn = path.join(dir, 'invoice-approval.bpmn');
      const exitSpy = spyOnExit();

      await buildAction(INVOICE_APPROVAL_SRC, { output: outBpmn });

      expect(exitSpy).not.toHaveBeenCalled();

      expect(fs.existsSync(outBpmn)).toBe(true);

      const xml = fs.readFileSync(outBpmn, 'utf-8');
      let ir;
      try {
        ({ ir } = await xmlToIr(xml));
      } catch (e) {
        throw new Error(
          `xmlToIr threw on the built output: ${(e as Error).message}`,
        );
      }

      expect(ir.id).toBe('invoice-approval');
    });
  });
});

describe('parseAction smoke', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses invoice-approval-generated.bpmn; re-parsing the emitted DSL yields zero parser errors', async () => {
    await withTempDir(async (dir) => {
      const outDsl = path.join(dir, 'invoice-approval.bpmnscript');
      const exitSpy = spyOnExit();

      await parseAction(GOLDEN_GENERATED_BPMN, { output: outDsl });

      expect(exitSpy).not.toHaveBeenCalled();

      expect(fs.existsSync(outDsl)).toBe(true);

      const dsl = fs.readFileSync(outDsl, 'utf-8');
      const doc = await parse(dsl);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
    });
  });
});

// `formRef` and the lane are both dropped without loss of behavior, so
// `xmlToIr` warns instead of refusing.
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
                   operaton:assignee="alice" operaton:asyncBefore="true"
                   operaton:formRef="review-form" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseAction: import-warning surfacing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a dropped extension attribute and a lane print warning text + element id to stderr and do not fail the parse', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'warns.bpmn');
      const outDsl = path.join(dir, 'warns.bpmnscript');
      fs.writeFileSync(srcFile, LANE_AND_ASYNC_ATTR_BPMN, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await parseAction(srcFile, { output: outDsl });

      expect(exitSpy).not.toHaveBeenCalled();

      expect(fs.existsSync(outDsl)).toBe(true);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');

      expect(stderrOutput).toContain('formRef');
      expect(stderrOutput).toContain('AsyncTask');

      expect(stderrOutput).toContain('Lane_Ops');
    });
  });
});

// Back-edge into a parallel fork (`B -> Fork`). The fork's out-edges are already
// consumed when the back-arrival is reached, so the decompiler emits the
// hand-repair marker instead of a `goto`. Only hand-built BPMN gets here.
const UNSTRUCTURED_FORK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="unstructured" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:parallelGateway id="Fork" />
    <bpmn:userTask id="A" name="A" />
    <bpmn:userTask id="B" name="B" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Fork" />
    <bpmn:sequenceFlow id="F1" sourceRef="Fork" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="Fork" targetRef="B" />
    <bpmn:sequenceFlow id="F3" sourceRef="A" targetRef="E" />
    <bpmn:sequenceFlow id="F4" sourceRef="B" targetRef="Fork" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseAction: unstructured-region hand-repair warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a marker-containing decompile prints the hand-repair warning to stderr, exits 0, and still writes the file', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'unstructured.bpmn');
      const outDsl = path.join(dir, 'unstructured.bpmnscript');
      fs.writeFileSync(srcFile, UNSTRUCTURED_FORK_BPMN, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await parseAction(srcFile, { output: outDsl });

      expect(exitSpy).not.toHaveBeenCalled();

      expect(fs.existsSync(outDsl)).toBe(true);
      expect(fs.readFileSync(outDsl, 'utf-8')).toContain(
        '// unstructured region: hand-repair required',
      );

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('unstructured region');
      expect(stderrOutput).toContain('hand-repair');
    });
  });
});

const CONDITIONAL_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  targetNamespace="http://test">
  <bpmn:process id="conditional" isExecutable="true">
    <bpmn:startEvent id="ConditionalStart">
      <bpmn:conditionalEventDefinition id="cd">
        <bpmn:condition xsi:type="bpmn:tFormalExpression">\${stockLevel &lt; 5}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="ConditionalStart" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseAction: refused-construct classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a conditional start event refuses loudly with exit code 1, an actionable message, and no output file', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'conditional.bpmn');
      const outDsl = path.join(dir, 'conditional.bpmnscript');
      fs.writeFileSync(srcFile, CONDITIONAL_START_BPMN, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        parseAction(srcFile, { output: outDsl }),
      ).rejects.toBeInstanceOf(ExitCalled);

      // 1 means unsupported construct; 2 would mean I/O or generic failure.
      expect(exitSpy).toHaveBeenCalledWith(1);

      expect(fs.existsSync(outDsl)).toBe(false);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('ConditionalStart');
      expect(stderrOutput).toContain('conditional');
    });
  });
});

// Uses `amount` without declaring it: severity 2.
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

// Declares `amount` as string, then compares it numerically: severity 1.
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

  it('warning-only source (undeclared variable) builds successfully (exit 0 path)', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'warning-only.bpmnscript');
      const outBpmn = path.join(dir, 'warning-only.bpmn');
      fs.writeFileSync(srcFile, WARNING_ONLY_SOURCE, 'utf-8');

      const exitSpy = spyOnExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        buildAction(srcFile, { output: outBpmn }),
      ).resolves.toBeUndefined();

      expect(exitSpy).not.toHaveBeenCalled();

      expect(fs.existsSync(outBpmn)).toBe(true);

      const stderrOutput = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(stderrOutput).toContain('amount');
      expect(stderrOutput).toContain('not declared');
    });
  });

  it('type-mismatch error source fails the build (exit 1 path)', async () => {
    await withTempDir(async (dir) => {
      const srcFile = path.join(dir, 'type-mismatch.bpmnscript');
      const outBpmn = path.join(dir, 'type-mismatch.bpmn');
      fs.writeFileSync(srcFile, TYPE_MISMATCH_SOURCE, 'utf-8');

      const exitSpy = spyOnExit();

      await expect(
        buildAction(srcFile, { output: outBpmn }),
      ).rejects.toBeInstanceOf(ExitCalled);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

describe('tmLanguage extension sync', () => {
  it('extension/syntaxes/ tmLanguage.json matches language/syntaxes/ (not stale)', () => {
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

  it('extension package.json has a build:prepare script that copies the tmLanguage', () => {
    const extensionPkgJson = path.resolve(
      REPO_ROOT,
      'packages/extension/package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(extensionPkgJson, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const preparescript = pkg.scripts?.['build:prepare'] ?? '';

    expect(
      preparescript,
      'build:prepare must mention language/syntaxes',
    ).toContain('language/syntaxes');
    expect(preparescript, 'build:prepare must mention ./syntaxes/').toContain(
      'syntaxes',
    );

    expect(preparescript, 'build:prepare must perform a file copy').toMatch(
      /\bcp\b/,
    );
  });
});
