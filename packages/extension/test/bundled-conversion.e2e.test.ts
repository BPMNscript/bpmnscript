// Run `npm run build` before this suite: it consumes the compiled out/
// directories of language, transform, and extension.
//
// What conversion makes of a given input is `conversion-core.test.ts`. What is
// under test here is the one thing only a bundle can answer: whether the
// transform still finds its moddle asset once esbuild has flattened it into a
// single CommonJS file, which is how the extension actually ships.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

// @ts-ignore esbuild.mjs is a plain JS module with no type declarations.
import { sharedBuildOptions, assetCopyPlugin } from '../esbuild.mjs';

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

if (!fs.existsSync(GOLDEN_GENERATED_BPMN)) {
  throw new Error(`Fixture not found: ${GOLDEN_GENERATED_BPMN}`);
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
