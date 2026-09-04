import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { LangiumDocument } from 'langium';

/** Read off the document so the shape is Langium's own, not a restatement. */
type Diagnostic = NonNullable<LangiumDocument['diagnostics']>[number];

/**
 * A diagnostic carries its message as plain text or as LSP markup. Everything
 * the language server raises is text, but the union has to be read either way:
 * printed straight into a template literal, a markup message reaches the author
 * as `[object Object]` instead of the diagnostic.
 */
export function diagnosticMessage(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === 'string'
    ? diagnostic.message
    : diagnostic.message.value;
}

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
