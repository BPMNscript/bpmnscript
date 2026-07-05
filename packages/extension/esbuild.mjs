import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const success = watch ? 'Watch build succeeded' : 'Build succeeded';

// Resolve paths relative to this build script, not the caller's cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Source operaton-moddle.json lives in the transform package next to the TS
// files that read it; its out/ copy is what normal consumers see, but the
// bundle needs a copy beside itself (see assetCopyPlugin below).
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

/**
 * esbuild plugin: copies operaton-moddle.json beside the bundle after every
 * successful build, including --watch rebuilds.
 *
 * Why this is needed: the transform package locates the JSON at module-init
 * time via dirname(fileURLToPath(import.meta.url)). Under the CJS bundle the
 * import.meta.url shim (below) resolves to the bundle file, so moduleDir ===
 * the bundle's output directory. Copying the asset there satisfies the
 * transform resolver's first candidate:
 *   join(moduleDir, 'operaton-moddle.json') → out/extension/operaton-moddle.json
 *
 * Exported so that verify/test bundles can include it and get the same copy
 * behaviour without duplicating the path logic.
 */
export const assetCopyPlugin = {
  name: 'asset-copy',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const opts = build.initialOptions;
      let targetDir;
      if (opts.outfile) {
        // Single-file output (e.g. a verify/test bundle): copy beside it.
        // Use an absolute-path-aware resolution so this works regardless of cwd.
        targetDir = isAbsolute(opts.outfile)
          ? dirname(opts.outfile)
          : resolve(process.cwd(), dirname(opts.outfile));
      } else {
        // outdir-based output: extension entry maps to outdir/extension/.
        targetDir = resolve(__dirname, opts.outdir ?? 'out', 'extension');
      }
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(operatonModdleSrc, join(targetDir, 'operaton-moddle.json'));
    });
  },
};

/**
 * Shared esbuild options — exported so that any verify/test bundle uses the
 * identical configuration as the production extension bundle. In particular:
 *
 *   define + banner: needed because @bpmn-script/transform reads
 *   fileURLToPath(import.meta.url) at module-init time. esbuild's CJS output
 *   otherwise leaves import.meta.url as undefined, causing
 *   ERR_INVALID_ARG_TYPE on activation. The banner injects a CJS-compatible
 *   definition at the top of the bundle before any module-init code runs.
 *
 * Callers should override entryPoints / outfile / outdir and add their own
 * plugins (assetCopyPlugin is exported separately for the same reason).
 */
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

// ── Production build entry ────────────────────────────────────────────────────
// Guard with isMain so that importing this module (e.g. from a test to obtain
// sharedBuildOptions) does not trigger a production build as a side effect.
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
