import bpmnIo from 'eslint-plugin-bpmn-io';
import prettierConfig from 'eslint-config-prettier';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

// The bpmn-io recommended config is an array of flat-config objects.
const recommended = bpmnIo.configs.recommended;

export default [
  {
    ignores: [
      '**/out/**',
      '**/src/generated/**',
      '**/syntaxes/**',

      // Compiled JS test files (vitest / tsc output sitting next to .ts
      // sources in test/ directories — not in out/).
      'packages/**/test/*.js',
      'packages/**/test/*.js.map',

      // Compiled JS/d.ts artefacts that leaked into src/ directories from
      // early-stage tsc runs without outDir. Stale and never re-emitted.
      'packages/**/src/**/*.js',
      'packages/**/src/**/*.js.map',
      'packages/**/src/**/*.d.ts',

      // Maven build output.
      'examples/spring-boot/target/**',

      // Package dependency trees.
      'node_modules/**',
      '**/node_modules/**',
    ],
  },

  // -----------------------------------------------------------------------
  // 2. Base rules — bpmn-io recommended applied to all remaining files.
  // -----------------------------------------------------------------------
  ...recommended,

  // -----------------------------------------------------------------------
  // 3. TypeScript source files — add the TS parser and Node globals.
  // -----------------------------------------------------------------------
  {
    files: ['packages/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
  },

  // -----------------------------------------------------------------------
  // 4. Plain JS / MJS files — add Node globals.
  // -----------------------------------------------------------------------
  {
    files: ['packages/**/*.js', 'packages/**/*.mjs', 'tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
  },

  // -----------------------------------------------------------------------
  // 5. Webview assets — browser globals plus the VS Code webview API.
  // sidebar.js runs inside the VS Code webview (Chromium sandbox), not
  // Node, so it needs DOM globals and the injected acquireVsCodeApi().
  // -----------------------------------------------------------------------
  {
    files: ['packages/extension/media/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        acquireVsCodeApi: 'readonly',
      },
    },
  },

  // -----------------------------------------------------------------------
  // 6. Prettier — disables all ESLint rules that conflict with Prettier.
  // -----------------------------------------------------------------------
  prettierConfig,
];
