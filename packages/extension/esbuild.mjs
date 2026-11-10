import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const success = watch ? 'Watch build succeeded' : 'Build succeeded';

function getTime() {
  const date = new Date();
  return `[${padZeroes(date.getHours())}:${padZeroes(date.getMinutes())}:${padZeroes(date.getSeconds())}] `;
}

function padZeroes(i) {
  return i.toString().padStart(2, '0');
}

export const sharedBuildOptions = {
  bundle: true,
  target: 'ES2022',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  loader: { '.ts': 'ts' },
  external: ['vscode'],
  platform: 'node',
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
    plugins: [watchPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    ctx.dispose();
  }
}
