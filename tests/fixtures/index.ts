import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ActiveTask, FixtureAdapter, FixtureMode } from './types.js';
import * as springBootAdapter from './adapters/spring-boot.js';
import * as externalTasksAdapter from './adapters/external-tasks.js';
import * as standaloneAdapter from './adapters/standalone.js';

export type { ActiveTask, FixtureAdapter, FixtureMode };

// Uses the real `bpmns` CLI, not the library, so the CLI stays on the path.
export function buildExample(dslPath: string, xmlOutPath: string): void {
  mkdirSync(dirname(xmlOutPath), { recursive: true });
  execFileSync('npx', ['bpmns', 'build', dslPath, '-o', xmlOutPath], {
    stdio: 'inherit',
  });
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
