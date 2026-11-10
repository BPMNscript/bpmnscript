// Writes the browser files to out/: the worker bundle, the Monarch grammar,
// the language configuration and the licences that ship with the bundle.

import * as esbuild from 'esbuild';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

mkdirSync('out', { recursive: true });

// The browser platform fails the build on any Node builtin import.
const { metafile } = await esbuild.build({
  entryPoints: ['src/server-worker.ts'],
  outfile: 'out/server-worker.js',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  minify: true,
  target: 'es2022',
  legalComments: 'eof',
  metafile: true,
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

// The minified bundle drops the packages' own headers, so ship their notices.
const packageDirs = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const marker = input.lastIndexOf('node_modules/');
  if (marker === -1) continue;
  const [first, second] = input.slice(marker + 13).split('/');
  const name = first.startsWith('@') ? `${first}/${second}` : first;
  packageDirs.add(input.slice(0, marker + 13) + name);
}

const notices = [...packageDirs].map((dir) => {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : (pkg.license?.type ?? 'not declared');
  const file = readdirSync(dir).find((f) => /^licen[sc]e(\.|$)/i.test(f));
  const text = file
    ? readFileSync(`${dir}/${file}`, 'utf8').trim()
    : `No license file was found in the package; its package.json declares: ${license}`;
  return { name: pkg.name, version: pkg.version, license, text };
});
notices.sort(
  (a, b) =>
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
);

writeFileSync(
  'out/THIRD_PARTY_NOTICES.txt',
  `Third-party software bundled in server-worker.js\n\n${notices
    .map(
      (n) =>
        `${'='.repeat(72)}\n${n.name}@${n.version} (${n.license})\n${'='.repeat(72)}\n\n${n.text}\n`,
    )
    .join('\n')}`,
);
