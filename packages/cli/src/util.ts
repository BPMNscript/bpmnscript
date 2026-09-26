import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import type { LangiumDocument } from 'langium';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createBpmnScriptServices } from '@bpmn-script/language';

/** Read off the document so the shape is Langium's own, not a restatement. */
type Diagnostic = NonNullable<LangiumDocument['diagnostics']>[number];

/** LSP's `DiagnosticSeverity` values; both actions filter diagnostics by these. */
export const SEVERITY_ERROR = 1;
export const SEVERITY_WARNING = 2;

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
  const base = path.basename(resolvedInput, path.extname(resolvedInput));
  if (outputOverride === undefined) {
    return path.join(path.dirname(resolvedInput), `${base}${defaultExt}`);
  }
  const resolved = path.resolve(outputOverride);
  // `-o some/dir` names a place to put the file, not the file itself: without
  // this, the write later fails with a bare EISDIR.
  return existsSync(resolved) && statSync(resolved).isDirectory()
    ? path.join(resolved, `${base}${defaultExt}`)
    : resolved;
}

export type GuardOptions = { force?: boolean };

/**
 * Refuses two destructive shapes before either action reads its input:
 * an output path identical to the input, and an existing output without
 * `--force`. Both actions call this right after resolving the output path.
 */
export function guardOutputPath(
  resolvedInput: string,
  outPath: string,
  opts: GuardOptions,
): void {
  if (outPath === resolvedInput) {
    console.error(
      chalk.red('Error: the input and the output are the same file'),
    );
    process.exit(2);
  }
  if (!opts.force && existsSync(outPath)) {
    console.error(
      chalk.red(
        `Error: ${outPath} exists; pass --force to overwrite it or -o for another path`,
      ),
    );
    process.exit(2);
  }
}

/**
 * Parses and validates a BpmnScript document through Langium's own pipeline.
 * `build` loads the file it was given this way; `parse` reloads the file it
 * just wrote the same way, to catch what the print step (which never
 * refuses, ADR-0014) still draws wrong.
 */
export async function buildDocument(
  filePath: string,
): Promise<LangiumDocument> {
  const services = createBpmnScriptServices(NodeFileSystem).BpmnScript;
  const document =
    await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(filePath),
    );
  await services.shared.workspace.DocumentBuilder.build([document], {
    validation: true,
  });
  return document;
}

/** `  line N: message [snippet]`, the shape both actions print a diagnostic in. */
export function formatDiagnostic(
  document: LangiumDocument,
  diagnostic: Diagnostic,
): string {
  return (
    `  line ${diagnostic.range.start.line + 1}: ${diagnosticMessage(diagnostic)}` +
    ` [${document.textDocument.getText(diagnostic.range)}]`
  );
}

/** A directory has no text or document to read; refused before the loader turns it into a bare EISDIR. */
export function refuseDirectoryInput(
  resolvedInput: string,
  fileName: string,
): void {
  if (statSync(resolvedInput).isDirectory()) {
    console.error(chalk.red(`Error: ${fileName} is a directory`));
    process.exit(2);
  }
}
