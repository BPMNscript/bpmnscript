/**
 * Fixture harness entry point.
 *
 * `startFixture` is the single entry point for integration tests.  It
 * selects the appropriate adapter for the requested `FixtureMode`, delegates
 * to its `start()` factory, and returns a ready-to-use `FixtureAdapter`.
 *
 * Usage:
 * ```ts
 * import { startFixture } from '../fixtures/index.js';
 *
 * const fixture = await startFixture('spring-boot');
 * // ...use fixture...
 * await fixture.stop();
 * ```
 */

import type { FixtureAdapter, FixtureMode } from './types.js';
import * as springBootAdapter from './adapters/spring-boot.js';
import * as externalTasksAdapter from './adapters/external-tasks.js';
import * as standaloneAdapter from './adapters/standalone.js';

export type { FixtureAdapter, FixtureMode };

/**
 * Instantiate and start a fixture adapter for the requested deployment mode.
 *
 * @param mode  - Which Operaton deployment mode to target.
 * @returns A started `FixtureAdapter` ready to receive `deploy()` / `startProcess()` calls.
 * @throws  If the mode is not yet implemented or if the runtime cannot be started.
 */
export async function startFixture(mode: FixtureMode): Promise<FixtureAdapter> {
  switch (mode) {
    case 'spring-boot':
      return springBootAdapter.start();
    case 'external-tasks':
      return externalTasksAdapter.start();
    case 'standalone':
      return standaloneAdapter.start();
    default: {
      // Exhaustiveness guard — TypeScript narrows `mode` to `never` here.
      const _exhaustive: never = mode;
      throw new Error(`Unknown FixtureMode: ${String(_exhaustive)}`);
    }
  }
}
