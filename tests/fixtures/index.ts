import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActiveTask, FixtureAdapter } from './types.js';
import * as springBootAdapter from './adapters/spring-boot.js';

export type { ActiveTask, FixtureAdapter };

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
    [CLI_ENTRY, 'build', dslPath, '-o', xmlOutPath, '--force'],
    { stdio: 'inherit' },
  );
}

export async function startFixture(): Promise<FixtureAdapter> {
  return springBootAdapter.start();
}
