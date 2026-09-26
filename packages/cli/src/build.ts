import { BpmnScriptLanguageMetaData } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import chalk from 'chalk';
import * as path from 'node:path';

import { astToIr, irToXml, LayoutError } from '@bpmn-script/transform';
import {
  CLI_VERSION,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  buildDocument,
  diagnosticMessage,
  fail,
  formatDiagnostic,
  guardOutputPath,
  resolveInputPath,
  resolveOutputPath,
  warn,
  writeOutput,
} from './util.js';

type BuildOptions = {
  output?: string;
  force?: boolean;
};

export async function buildAction(
  fileName: string,
  opts: BuildOptions,
): Promise<void> {
  const resolvedInput = resolveInputPath(fileName);

  // The document loader picks its language service by extension, so a wrong
  // one cannot merely warn: it fails a few lines later with an internal
  // Langium message ("service registry contains no services").
  const extensions: readonly string[] =
    BpmnScriptLanguageMetaData.fileExtensions;
  if (!extensions.includes(path.extname(resolvedInput))) {
    fail(
      2,
      `Error: expected a file with one of these extensions: ${extensions.join(', ')}`,
    );
  }

  const outPath = resolveOutputPath(resolvedInput, '.bpmn', opts.output);
  guardOutputPath(resolvedInput, outPath, opts);

  let document;
  try {
    document = await buildDocument(resolvedInput);
  } catch (err) {
    fail(2, `Error: failed to parse ${fileName}: ${(err as Error).message}`);
  }

  const errors = (document.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_ERROR,
  );
  if (errors.length > 0) {
    console.error(chalk.red('Validation errors:'));
    for (const diag of errors) {
      console.error(chalk.red(formatDiagnostic(document, diag)));
    }
    process.exit(1);
  }

  // A blank or comment-only source parses clean into a model with no
  // processes, which astToIr would refuse in its own internal wording. Checked
  // after the error gate: a keyword typo also yields zero processes and should
  // report its parser error instead.
  const ast = document.parseResult.value as Model;
  if (ast.processes.length === 0) fail(1, 'Error: the file has no process');

  const warnings = (document.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_WARNING,
  );
  for (const diag of warnings) {
    warn(
      `Warning: line ${diag.range.start.line + 1}: ${diagnosticMessage(diag)}`,
    );
  }

  // The extension's conversion-core.ts and tests/helpers/pipeline.ts run the
  // same astToIr -> irToXml chain, each with its own failure reporting.
  let ir;
  try {
    ir = astToIr(ast);
  } catch (err) {
    fail(1, `Error: ${(err as Error).message}`);
  }

  let xml: string;
  try {
    xml = await irToXml(ir, { exporterVersion: CLI_VERSION });
  } catch (err) {
    if (!(err instanceof LayoutError)) {
      fail(1, `Error: ${(err as Error).message}`);
    }
    // Operaton deploys the document without a diagram, so it is written
    // rather than lost.
    xml = err.xml;
    warn(
      `Warning: no diagram could be drawn for this process (${err.message}); the file deploys but opens without shapes in a modeler`,
    );
  }

  await writeOutput(outPath, xml);
  console.log(chalk.green(`Built: ${outPath}`));
}
