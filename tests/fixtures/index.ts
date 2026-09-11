import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActiveTask, FixtureAdapter, FixtureMode } from './types.js';
import * as springBootAdapter from './adapters/spring-boot.js';
import * as externalTasksAdapter from './adapters/external-tasks.js';
import * as standaloneAdapter from './adapters/standalone.js';

export type { ActiveTask, FixtureAdapter, FixtureMode };

// Addressed by path rather than run through `npx`, which resolves a command by
// walking `node_modules/.bin` upwards and so can reach a neighbouring checkout's
// build instead of this one's.
const CLI_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/cli/bin/cli.js',
);

// Runs the CLI entry module rather than the library, so the CLI's own argument
// handling and output stay on the path. The bin mapping and the shebang are
// npm's contract, and are the one thing this gives up.
export function buildExample(dslPath: string, xmlOutPath: string): void {
  mkdirSync(dirname(xmlOutPath), { recursive: true });
  execFileSync(
    process.execPath,
    [CLI_ENTRY, 'build', dslPath, '-o', xmlOutPath],
    { stdio: 'inherit' },
  );
}

export async function startFixture(mode: FixtureMode): Promise<FixtureAdapter> {
  switch (mode) {
    case 'spring-boot':
      return springBootAdapter.start();
    case 'external-tasks':
      return externalTasksAdapter.start();
    case 'standalone':
      return standaloneAdapter.start();
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown FixtureMode: ${String(_exhaustive)}`);
    }
  }
}
