// Every golden, fixture and example on the engine, in one boot: once as the
// file is written, and once rebuilt from the tool's own print of it. The
// second table is where a defect of the first kind hides: a deployable file
// whose print compiles back to one the engine refuses.
//
// Each row deploys in a tenant of its own, because
// BpmnDeployer.addMessageStartEventSubscription refuses a second message start
// of one name across process definitions in one tenant, and two independent
// files here start on the same message. The same process key deployed twice
// is only a new version to the engine and needs nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { astToIr, irToXml, xmlToIr } from '@bpmn-script/transform';

import { buildExample, startFixture } from '../fixtures/index.js';
import type { FixtureAdapter } from '../fixtures/index.js';
import {
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import { parseToAst, printDsl } from '../helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const OUT_DIR = resolve(REPO_ROOT, 'out/deploy-sweep');

// The engine's message for each file it refuses on purpose, keyed by row.
// BpmnParse.validateServiceTaskLike: a service task without a binding.
const ENGINE_REFUSES: Record<string, RegExp> = {
  'golden-bad-service-task-no-binding': /is mandatory on serviceTask/,
};

// The files the importer refuses on purpose: the bindingless service task,
// and an error start event, which the DSL has no form for.
const IMPORT_REFUSES: ReadonlySet<string> = new Set([
  'golden-bad-service-task-no-binding',
  'fixture-error-start',
]);

interface Row {
  // `<origin>-<basename>`, since a golden and an example share basenames.
  key: string;
  xmlPath: string;
  // Present for an example, which the CLI compiles into `xmlPath` first.
  dslPath?: string;
}

// A directory-driven sweep that finds nothing would pass by asserting nothing.
function filesUnder(dir: string, extension: string): string[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(extension))
    .sort();
  if (files.length === 0) {
    throw new Error(`no ${extension} files found under ${dir}`);
  }
  return files;
}

function bpmnRows(origin: string, dir: string): Row[] {
  return filesUnder(dir, '.bpmn').map((file) => ({
    key: `${origin}-${basename(file, '.bpmn')}`,
    xmlPath: resolve(dir, file),
  }));
}

const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples/spring-boot/processes');

const ROWS: Row[] = [
  ...bpmnRows('golden', resolve(REPO_ROOT, 'tests/golden')),
  ...bpmnRows('fixture', resolve(REPO_ROOT, 'tests/fixtures')),
  ...filesUnder(EXAMPLES_DIR, '.bpmnscript').map((file) => {
    const name = basename(file, '.bpmnscript');
    return {
      key: `example-${name}`,
      xmlPath: resolve(OUT_DIR, `${name}.bpmn`),
      dslPath: resolve(EXAMPLES_DIR, file),
    };
  }),
];

describe.skipIf(SKIP)('E2E: every golden, fixture and example deploys', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    for (const row of ROWS) {
      if (row.dslPath !== undefined) {
        buildExample(row.dslPath, row.xmlPath);
      }
    }
    fixture = await startFixture('spring-boot');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  }, ENGINE_STOP_TIMEOUT_MS);

  it.each(ROWS)(
    '$key deploys as written',
    async ({ key, xmlPath }) => {
      const name = `${key}-as-written`;
      const refusal = ENGINE_REFUSES[key];
      if (refusal !== undefined) {
        await expect(fixture.deploy(xmlPath, name, name)).rejects.toThrow(
          refusal,
        );
        return;
      }
      const { deploymentId } = await fixture.deploy(xmlPath, name, name);
      expect(deploymentId).toBeTruthy();
    },
    60_000,
  );

  it.each(ROWS)(
    '$key deploys again after a trip through the printer and the compiler',
    async ({ key, xmlPath }) => {
      const xml = readFileSync(xmlPath, 'utf-8');
      if (IMPORT_REFUSES.has(key)) {
        await expect(xmlToIr(xml)).rejects.toThrow();
        return;
      }
      const { ir } = await xmlToIr(xml);
      const rebuilt = await irToXml(astToIr(await parseToAst(printDsl(ir))));
      const rebuiltPath = resolve(OUT_DIR, 'rebuilt', `${key}.bpmn`);
      mkdirSync(dirname(rebuiltPath), { recursive: true });
      writeFileSync(rebuiltPath, rebuilt);

      const name = `${key}-rebuilt`;
      const { deploymentId } = await fixture.deploy(rebuiltPath, name, name);
      expect(deploymentId).toBeTruthy();
    },
    60_000,
  );
});
