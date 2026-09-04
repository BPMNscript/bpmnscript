// Run `npm run build` before this suite: it consumes the compiled out/
// directories of language, transform, and extension.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

// @ts-ignore esbuild.mjs is a plain JS module with no type declarations.
import { sharedBuildOptions, assetCopyPlugin } from '../esbuild.mjs';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
} from '../src/extension/conversion-core.js';

// Vitest transforms TS in place, so import.meta.url resolves to this source
// file, not to any out/ directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

const EXT_DIR = path.resolve(__dirname, '..');

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-no-binding.bpmn',
);

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

for (const [label, p] of [
  ['invoice-approval-generated.bpmn', GOLDEN_GENERATED_BPMN],
  ['bad-service-task-no-binding.bpmn', BAD_SERVICE_TASK_BPMN],
  ['invoice-approval.bpmnscript', INVOICE_APPROVAL_SRC],
] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture not found: ${label} at ${p}`);
  }
}

describe('bundled asset resolution and transform under the shim', () => {
  // Unique per run: parallel suites would otherwise collide on these paths.
  const runId = `${process.pid}-${Date.now()}`;
  const verifyEntryFile = path.join(os.tmpdir(), `verify-entry-${runId}.js`);
  // Under out/extension/ so assetCopyPlugin lands operaton-moddle.json beside
  // it whatever the cwd, which is what the import.meta.url shim then resolves.
  const verifyOutfile = path.resolve(
    EXT_DIR,
    'out',
    'extension',
    `verify-${runId}.cjs`,
  );

  beforeAll(async () => {
    const moddlePath = path.resolve(
      EXT_DIR,
      'out',
      'extension',
      'operaton-moddle.json',
    );
    if (!fs.existsSync(moddlePath)) {
      throw new Error(
        `operaton-moddle.json missing at ${moddlePath}. ` +
          'Run `npm run build` from the repo root before this suite.',
      );
    }

    // The async IIFE keeps top-level await out of the CJS output.
    const entrySource = [
      "import { xmlToIr, irToXml } from '@bpmn-script/transform';",
      "import { readFileSync } from 'node:fs';",
      '(async () => {',
      '  const bpmnPath = process.argv[2];',
      "  const xml = readFileSync(bpmnPath, 'utf-8');",
      '  const { ir } = await xmlToIr(xml);',
      "  const bpmnOut = await irToXml(ir, { sourceFileName: 'verify', exporterVersion: '0.0.1' });",
      "  process.stdout.write('PROCESS_ID:' + ir.id + '\\n');",
      '  process.stdout.write(bpmnOut);',
      '})().catch(err => { console.error(err); process.exit(1); });',
    ].join('\n');

    fs.writeFileSync(verifyEntryFile, entrySource, 'utf-8');

    // nodePaths is required: the entry lives in /tmp/, so esbuild's resolution
    // walk finds no node_modules and cannot resolve @bpmn-script/transform.
    await esbuild.build({
      ...sharedBuildOptions,
      entryPoints: [verifyEntryFile],
      outfile: verifyOutfile,
      nodePaths: [path.resolve(REPO_ROOT, 'node_modules')],
      plugins: [assetCopyPlugin],
    });
  }, 60_000);

  afterAll(() => {
    // Only the two per-run files; out/extension/operaton-moddle.json belongs to
    // the production build and must survive.
    if (fs.existsSync(verifyEntryFile)) fs.unlinkSync(verifyEntryFile);
    if (fs.existsSync(verifyOutfile)) fs.unlinkSync(verifyOutfile);
  });

  it(
    'the bundle resolves its moddle asset under plain Node and produces the expected process id and BPMN XML',
    { timeout: 35_000 },
    () => {
      expect(
        fs.existsSync(verifyOutfile),
        `verify bundle missing at ${verifyOutfile}: esbuild step failed`,
      ).toBe(true);

      const result = spawnSync(
        process.execPath,
        [verifyOutfile, GOLDEN_GENERATED_BPMN],
        { encoding: 'utf-8', timeout: 30_000 },
      );

      expect(
        result.status,
        `node exited with code ${result.status}:\nstderr: ${result.stderr}`,
      ).toBe(0);

      const { stdout } = result;

      expect(stdout).toContain('PROCESS_ID:invoice-approval');
      expect(stdout).toContain('bpmn:definitions');
    },
  );
});

describe('DSL to BPMN journey with disk write round-trip', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmnscript-e2e-'));
  });

  afterAll(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  });

  it(
    'compiles invoice-approval.bpmnscript, writes .bpmn to temp dir, re-imports via xmlToIr; process key is invoice-approval',
    { timeout: 30_000 },
    async () => {
      const source = fs.readFileSync(INVOICE_APPROVAL_SRC, 'utf-8');

      const result = await compileDslToBpmn(
        source,
        'invoice-approval.bpmnscript',
        '0.0.1',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const outFile = path.join(tmpDir, 'invoice-approval.bpmn');
      fs.writeFileSync(outFile, result.output, 'utf-8');

      const xml = fs.readFileSync(outFile, 'utf-8');
      const { ir } = await xmlToIr(xml);

      expect(ir.id).toBe('invoice-approval');
    },
  );
});

describe('decompile journey: BPMN to DSL with Langium re-parse', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it(
    'decompiles invoice-approval-generated.bpmn; output re-parses with zero parser errors',
    { timeout: 30_000 },
    async () => {
      const xml = fs.readFileSync(GOLDEN_GENERATED_BPMN, 'utf-8');

      const result = await decompileBpmnToDsl(
        xml,
        'invoice-approval-generated.bpmn',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const doc = await parse(result.output);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
    },
  );
});

describe('validation gate: type-mismatch error blocks output', () => {
  it(
    'returns kind:validation and produces no output for a type-mismatch source',
    { timeout: 30_000 },
    async () => {
      // String `name` in a numeric comparison: a severity-1 diagnostic.
      const source = `process p {
  var name: string
  if (name > 1000) { user A }
}
`;

      const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.kind).toBe('validation');

      // The union type alone does not stop the adapter writing result.output
      // if a kind check goes missing, so assert the field is absent.
      expect('output' in result).toBe(false);

      if (result.kind === 'validation') {
        expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      }
    },
  );
});

describe('unsupported-construct gate: bad-service-task-no-binding.bpmn', () => {
  it(
    'returns kind:unsupported for a BPMN whose service task carries no execution discriminator',
    { timeout: 30_000 },
    async () => {
      const xml = fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8');

      const result = await decompileBpmnToDsl(
        xml,
        'bad-service-task-no-binding.bpmn',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.kind).toBe('unsupported');
    },
  );
});
