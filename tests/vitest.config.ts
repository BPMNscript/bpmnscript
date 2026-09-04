import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    deps: {
      interopDefault: true,
    },
    include: ['**/*.test.ts'],
    exclude: ['out/**', 'node_modules/**'],
  },
});
