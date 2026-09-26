import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const success = watch ? 'Watch build succeeded' : 'Build succeeded';

// Resolve paths relative to this build script, not the caller's cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const operatonModdleSrc = resolve(
  __dirname,
  '../transform/src/operaton-moddle.json',
);

function getTime() {
  const date = new Date();
  return `[${padZeroes(date.getHours())}:${padZeroes(date.getMinutes())}:${padZeroes(date.getSeconds())}] `;
}

function padZeroes(i) {
  return i.toString().padStart(2, '0');
}

// Copies operaton-moddle.json beside the bundle after every build, watch
// rebuilds included: the transform package locates it at module init through
// dirname(fileURLToPath(import.meta.url)), which under the shim below is the
// bundle's own directory.
export const assetCopyPlugin = {
  name: 'asset-copy',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const opts = build.initialOptions;
      // outfile is a single-file test bundle; outdir is the extension build,
      // whose entry lands under outdir/extension/.
      const targetDir = opts.outfile
        ? resolve(dirname(opts.outfile))
        : resolve(__dirname, opts.outdir ?? 'out', 'extension');
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(operatonModdleSrc, join(targetDir, 'operaton-moddle.json'));
    });
  },
};

// define + banner: @bpmn-script/transform reads fileURLToPath(import.meta.url)
// at module init, and esbuild's CJS output otherwise leaves import.meta.url
// undefined, which throws ERR_INVALID_ARG_TYPE on activation.
export const sharedBuildOptions = {
  bundle: true,
  target: 'ES2022',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  loader: { '.ts': 'ts' },
  external: ['vscode'],
  platform: 'node',
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
};

// The test bundle imports this module for the options above; only a direct
// `node esbuild.mjs` builds.
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const watchPlugin = {
    name: 'watch-plugin',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          console.log(getTime() + success);
        }
      });
    },
  };

  const ctx = await esbuild.context({
    ...sharedBuildOptions,
    entryPoints: ['src/extension/main.ts', 'src/language/main.ts'],
    outdir: 'out',
    sourcemap: !minify,
    minify,
    plugins: [assetCopyPlugin, watchPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    ctx.dispose();
  }
}
