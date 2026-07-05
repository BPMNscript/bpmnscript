/**
 * Bundled extension E2E and integration tests.
 *
 * Confirms the production esbuild shim (import.meta.url) and the real
 * operaton-moddle.json both work inside a CJS bundle: a tiny verify entry is
 * bundled with the same sharedBuildOptions as the production extension and
 * spawned under plain node — no VS Code host needed.
 *
 * Also exercises the conversion-core API directly against real repo
 * fixtures, including a disk-write round-trip (temp dir), Langium re-parse,
 * error-gating, and unsupported-construct rejection.
 *
 * Build-order requirement: run `npm run build` (language + transform +
 * extension) before this suite. The conversion-core, esbuild.mjs, and the
 * verify entry all consume compiled out/ directories.
 */

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

// @ts-ignore — esbuild.mjs is a plain JS module; types are inferred at runtime.
import { sharedBuildOptions, assetCopyPlugin } from '../esbuild.mjs';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
} from '../src/extension/conversion-core.js';

// ---------------------------------------------------------------------------
// Path resolution — mirrors cli/test/build-parse.smoke.test.ts convention.
// Vitest transforms TS in place, so import.meta.url resolves to the source
// file, not any compiled output directory.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Three levels up from packages/extension/test/ → monorepo root. */
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** packages/extension/ */
const EXT_DIR = path.resolve(__dirname, '..');

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-expression.bpmn',
);

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

// Fail loudly at module load if fixtures are missing — surface path errors early.
for (const [label, p] of [
  ['invoice-approval-generated.bpmn', GOLDEN_GENERATED_BPMN],
  ['bad-service-task-expression.bpmn', BAD_SERVICE_TASK_BPMN],
  ['invoice-approval.bpmnscript', INVOICE_APPROVAL_SRC],
] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture not found: ${label} at ${p}`);
  }
}

// A tiny entry is bundled with the SAME esbuild options as the production
// extension (sharedBuildOptions + assetCopyPlugin). The outfile lands in
// out/extension/ so the import.meta.url shim resolves beside the real
// operaton-moddle.json, exercising the shim and the asset copy together at
// runtime.

describe('bundled asset resolution and transform under the shim', () => {
  // Unique filenames per run to avoid collisions when suites run in parallel.
  const runId = `${process.pid}-${Date.now()}`;
  const verifyEntryFile = path.join(os.tmpdir(), `verify-entry-${runId}.js`);
  // Absolute path under out/extension/ so the assetCopyPlugin lands
  // operaton-moddle.json beside this file regardless of cwd.
  const verifyOutfile = path.resolve(
    EXT_DIR,
    'out',
    'extension',
    `verify-${runId}.cjs`,
  );

  beforeAll(async () => {
    // Assert the production extension build ran; operaton-moddle.json must be present.
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

    // Write a tiny verify entry: xmlToIr then irToXml exercised inside the bundle.
    // Top-level await is wrapped in an async IIFE for safe CJS output.
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

    // Bundle with the identical configuration as the production extension.
    // Single source of truth: sharedBuildOptions contains the import.meta.url
    // shim (see esbuild.mjs); assetCopyPlugin copies operaton-moddle.json
    // beside the bundle's outfile.
    //
    // nodePaths provides the repo-root node_modules to esbuild so that
    // @bpmn-script/transform is resolvable when the entry file lives in /tmp/.
    // Without it, esbuild's package-resolution walk from /tmp/ finds nothing.
    await esbuild.build({
      ...sharedBuildOptions,
      entryPoints: [verifyEntryFile],
      outfile: verifyOutfile,
      nodePaths: [path.resolve(REPO_ROOT, 'node_modules')],
      plugins: [assetCopyPlugin],
    });
  }, 60_000 /* esbuild bundling budget */);

  afterAll(() => {
    // Clean up: temp entry file and verify bundle. The real operaton-moddle.json
    // in out/extension/ is not touched (it was produced by the production build).
    if (fs.existsSync(verifyEntryFile)) fs.unlinkSync(verifyEntryFile);
    if (fs.existsSync(verifyOutfile)) fs.unlinkSync(verifyOutfile);
  });

  it(
    'the bundle resolves its moddle asset under plain Node and produces the expected process id and BPMN XML',
    { timeout: 35_000 },
    () => {
      expect(
        fs.existsSync(verifyOutfile),
        `verify bundle missing at ${verifyOutfile} — esbuild step failed`,
      ).toBe(true);

      // Spawn node on the bundled file with the golden BPMN as the argument;
      // the import.meta.url shim must resolve to out/extension/ so the
      // transform's operaton-moddle.json lookup succeeds.
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

      // The process id confirms xmlToIr parsed the BPMN correctly inside the bundle.
      expect(stdout).toContain('PROCESS_ID:invoice-approval');

      // bpmn:definitions confirms irToXml (including bpmn-auto-layout) produced output.
      expect(stdout).toContain('bpmn:definitions');
    },
  );
});

// compileDslToBpmn produces a BPMN XML string; it is written to a temp dir
// (mirroring what the VS Code adapter does); xmlToIr re-imports it from disk.

describe('DSL to BPMN journey with disk write round-trip', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmnscript-e2e-'));
  });

  afterAll(() => {
    // Remove all files produced in tmpDir, then the dir itself.
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

      // Write the compiled output to the temp dir — the same step the adapter performs.
      const outFile = path.join(tmpDir, 'invoice-approval.bpmn');
      fs.writeFileSync(outFile, result.output, 'utf-8');

      // Re-read and re-import from disk to close the round-trip loop.
      const xml = fs.readFileSync(outFile, 'utf-8');
      const { ir } = await xmlToIr(xml);

      expect(ir.id).toBe('invoice-approval');
    },
  );
});

describe('decompile journey — BPMN to DSL with Langium re-parse', () => {
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

// A bug in severity gating would silently emit invalid BPMN. This check
// confirms that a source with an error-level diagnostic produces no output.

describe('validation gate — type-mismatch error blocks output', () => {
  it(
    'returns kind:validation and produces no output for a type-mismatch source',
    { timeout: 30_000 },
    async () => {
      // `name` is declared as string but compared with a number — type-mismatch ERROR.
      const source = `process p {
  var name: string
  if (name > 1000) { user A }
}
`;

      const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.kind).toBe('validation');

      // Explicitly assert no output was produced — the type system alone
      // doesn't guarantee this; the adapter could still write result.output
      // if the kind check were missing.
      expect('output' in result).toBe(false);

      if (result.kind === 'validation') {
        expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      }
    },
  );
});

describe('unsupported-construct gate — bad-service-task-expression.bpmn', () => {
  it(
    'returns kind:unsupported for a BPMN with an unsupported service task expression',
    { timeout: 30_000 },
    async () => {
      const xml = fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8');

      const result = await decompileBpmnToDsl(
        xml,
        'bad-service-task-expression.bpmn',
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.kind).toBe('unsupported');
    },
  );
});
