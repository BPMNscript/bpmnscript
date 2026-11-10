// Writes the browser files to out/: the worker bundle, the Monarch grammar,
// the language configuration and the licences that ship with the bundle.

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

mkdirSync('out', { recursive: true });

// The browser platform fails the build on any Node builtin import.
await esbuild.build({
  entryPoints: ['src/server-worker.ts'],
  outfile: 'out/server-worker.js',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  minify: true,
  target: 'es2022',
  legalComments: 'eof',
  define: { BPMNSCRIPT_VERSION: JSON.stringify(version) },
});

await esbuild.build({
  entryPoints: ['../language/syntaxes/bpmn-script.monarch.ts'],
  outfile: 'out/monarch.js',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  target: 'es2022',
});

// The source is JSONC for VS Code; whole comment lines go so any JSON import reads it.
const languageConfiguration = readFileSync(
  '../language/language-configuration.json',
  'utf8',
).replace(/^\s*\/\/.*$/gm, '');
writeFileSync(
  'out/language-configuration.json',
  `${JSON.stringify(JSON.parse(languageConfiguration), null, 2)}\n`,
);

cpSync('../../LICENSE', 'out/LICENSE');
cpSync(
  '../transform/src/operaton-moddle.LICENSE',
  'out/operaton-moddle.LICENSE',
);
