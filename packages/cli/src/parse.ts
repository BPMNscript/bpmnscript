import { DiagnosticSeverity } from '@bpmn-script/language';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';

import {
  xmlToIr,
  irToDsl,
  EMPTY_INPUT_MESSAGE,
  readableParseError,
  xmlInputProblem,
  UnsupportedConstructError,
  MalformedDocumentError,
} from '@bpmn-script/transform';
import type { ImportWarning, PrintWarning } from '@bpmn-script/transform';
import {
  type CommandOptions,
  buildDocument,
  diagnosticsOf,
  fail,
  failInternal,
  formatDiagnostic,
  guardOutputPath,
  indentNotes,
  resolveInputPath,
  resolveOutputPath,
  warn,
  writeOutput,
} from './util.js';

export async function parseAction(
  fileName: string,
  opts: CommandOptions,
): Promise<void> {
  const resolvedInput = resolveInputPath(fileName);
  const outPath = resolveOutputPath(resolvedInput, '.bpmnscript', opts.output);
  guardOutputPath(resolvedInput, outPath, opts);

  let xml: string;
  try {
    xml = await fs.readFile(resolvedInput, 'utf-8');
  } catch (err) {
    fail(2, `Error: could not read ${fileName}: ${(err as Error).message}`);
  }

  const problem = xmlInputProblem(xml);
  if (problem === EMPTY_INPUT_MESSAGE) fail(2, `Error: ${problem}`);
  if (problem !== undefined) {
    fail(
      2,
      `Error: ${problem}\n  help: build a .bpmnscript file with 'bpmns build'`,
    );
  }

  let ir;
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    if (err instanceof UnsupportedConstructError) {
      fail(1, `Error: ${fileName}: ${indentNotes(err.message)}`);
    }
    if (!(err instanceof MalformedDocumentError)) failInternal(err);
    fail(
      2,
      `Error: failed to parse ${fileName}: ` +
        indentNotes(readableParseError(err.message, xml)),
    );
  }

  let dsl: string;
  let printWarnings: PrintWarning[];
  try {
    ({ source: dsl, warnings: printWarnings } = irToDsl(ir));
  } catch (err) {
    failInternal(err);
  }

  await writeOutput(outPath, dsl);
  console.log(chalk.green(`Parsed: ${outPath}`));

  for (const w of [...warnings, ...printWarnings]) {
    warn(`Warning: ${indentNotes(w.message)}`);
  }

  // Nothing above runs the validator, so rebuilding the written script is what catches an error.
  const rebuilt = await buildDocument(outPath).catch(failInternal);
  const buildErrors = diagnosticsOf(rebuilt, DiagnosticSeverity.Error);
  if (buildErrors.length > 0) {
    warn(
      `Warning: the printed script draws ${buildErrors.length} error(s) ` +
        'when built and needs hand-repair:',
    );
    for (const diag of buildErrors) {
      warn(formatDiagnostic(rebuilt, diag));
    }
  }
}
