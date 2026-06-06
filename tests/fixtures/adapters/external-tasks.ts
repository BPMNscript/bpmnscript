import type { FixtureAdapter } from '../types.js';

/**
 * Stub adapter for the external-tasks Operaton deployment mode.
 *
 * This mode is planned but not implemented yet. Any attempt to start it
 * throws immediately with a clear "not implemented" message.
 */
export function start(): Promise<FixtureAdapter> {
  throw new Error('FixtureAdapter "external-tasks" is not implemented yet');
}
