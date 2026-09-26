import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    deps: {
      interopDefault: true,
    },
    include: ['**/*.test.ts'],
    exclude: ['out/**', 'node_modules/**'],
    // Each end-to-end file boots its own Operaton container, and Vitest runs
    // one file per worker, so on a hosted runner the containers have to take
    // turns.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
