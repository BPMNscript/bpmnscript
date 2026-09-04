import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Resolved relative to this module, so it works from both `out/` (compiled) and
 * `src/` (vitest); both sit one level below the package root.
 */
export const CLI_VERSION: string = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { version: string }
).version;

export function resolveOutputPath(
  resolvedInput: string,
  defaultExt: string,
  outputOverride?: string,
): string {
  if (outputOverride !== undefined) {
    return path.resolve(outputOverride);
  }
  const dir = path.dirname(resolvedInput);
  const base = path.basename(resolvedInput, path.extname(resolvedInput));
  return path.join(dir, `${base}${defaultExt}`);
}
