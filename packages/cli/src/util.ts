import { existsSync, readFileSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import type { LangiumDocument } from 'langium';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import {
  createBpmnScriptServices,
  Diagnostic,
  DiagnosticSeverity,
} from '@bpmn-script/language';

export function fail(code: number, message: string): never {
  console.error(chalk.red(message));
  process.exit(code);
}

/** Exit 3: an unexpected exception in a transform, as opposed to bad input. */
export function failInternal(err: unknown): never {
  fail(3, `Error: internal error (a bug in bpmns): ${(err as Error).message}`);
}

export function warn(message: string): void {
  console.error(chalk.yellow(message));
}

/** Indents a message's note and help lines under its headline. */
export function indentNotes(message: string): string {
  return message.replaceAll('\n', '\n  ');
}

// One level below the package root in both `out/` and `src/`.
export const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { version: string }
).version;

/** Without these checks the loader fails with ENOENT or a bare EISDIR. */
export function resolveInputPath(fileName: string): string {
  const resolved = path.resolve(fileName);
  if (!existsSync(resolved)) fail(2, `Error: file not found: ${fileName}`);
  if (statSync(resolved).isDirectory()) {
    fail(2, `Error: ${fileName} is a directory`);
  }
  return resolved;
}

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
  // `-o some/dir` names a place for the file.
  return existsSync(resolved) && statSync(resolved).isDirectory()
    ? path.join(resolved, `${base}${defaultExt}`)
    : resolved;
}

export type CommandOptions = { output?: string; force?: boolean };

export function guardOutputPath(
  resolvedInput: string,
  outPath: string,
  opts: CommandOptions,
): void {
  if (outPath === resolvedInput) {
    fail(2, 'Error: the input and the output are the same file');
  }
  if (!opts.force && existsSync(outPath)) {
    fail(
      2,
      `Error: ${outPath} exists\n` +
        "  help: pass '--force' to overwrite it, or '-o' for another path",
    );
  }
}

export async function writeOutput(
  outPath: string,
  content: string,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, content, 'utf-8');
  } catch (err) {
    fail(
      2,
      `Error: could not write output to ${outPath}: ${(err as Error).message}`,
    );
  }
}

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

export function diagnosticsOf(
  document: LangiumDocument,
  severity: DiagnosticSeverity,
): Diagnostic[] {
  return (document.diagnostics ?? []).filter((d) => d.severity === severity);
}

export function formatDiagnostic(
  document: LangiumDocument,
  diagnostic: Diagnostic,
): string {
  const [headline, ...notes] =
    Diagnostic.getMessageString(diagnostic).split('\n');
  return [
    `  line ${diagnostic.range.start.line + 1}: ${headline}` +
      ` [${document.textDocument.getText(diagnostic.range)}]`,
    ...notes.map((note) => `    ${note}`),
  ].join('\n');
}
