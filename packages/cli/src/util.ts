/**
 * Shared CLI utilities for the `build` and `parse` subcommands.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * This package's own version, read once from its `package.json`. Used both
 * for the `--version` flag and as the `exporter` version stamped into
 * generated BPMN. The path is resolved relative to this module so it is
 * correct whether running from `out/` (compiled) or `src/` (vitest) — both
 * sit one level below the package root.
 */
export const CLI_VERSION: string = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { version: string }
).version;

/**
 * Compute the output file path for a CLI subcommand.
 *
 * When `outputOverride` is given it is used verbatim (resolved from cwd if
 * relative). Otherwise the path is derived from the input by swapping its
 * extension for `defaultExt` and writing the result next to the source.
 *
 * The trailing extension is stripped with `path.extname` rather than a
 * hard-coded suffix, so dotted basenames such as `my.invoice.bpmnscript`
 * keep everything before the final extension.
 *
 * @param resolvedInput  Absolute path to the input file.
 * @param defaultExt     Extension (including the leading dot) for the output.
 * @param outputOverride Optional explicit output path.
 */
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
