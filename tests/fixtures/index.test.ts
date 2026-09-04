import { describe, it, expect } from 'vitest';
import { startFixture } from './index.js';

describe('startFixture: stub adapters', () => {
  it('startFixture("external-tasks") throws "not implemented"', async () => {
    await expect(startFixture('external-tasks')).rejects.toThrow(
      'FixtureAdapter "external-tasks" is not implemented yet',
    );
  });

  it('startFixture("standalone") throws "not implemented"', async () => {
    await expect(startFixture('standalone')).rejects.toThrow(
      'FixtureAdapter "standalone" is not implemented yet',
    );
  });
});
