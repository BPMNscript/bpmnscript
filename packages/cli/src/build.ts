import {
  BpmnScriptLanguageMetaData,
  Diagnostic,
  DiagnosticSeverity,
} from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import chalk from 'chalk';
import * as path from 'node:path';

import {
  astToIr,
  irToXml,
  LayoutError,
  NO_PROCESS_MESSAGE,
} from '@bpmn-script/transform';
import {
  CLI_VERSION,
  type CommandOptions,
  buildDocument,
  fail,
  formatDiagnostic,
  guardOutputPath,
  resolveInputPath,
  resolveOutputPath,
  warn,
  writeOutput,
} from './util.js';

export async function buildAction(
  fileName: string,
  opts: CommandOptions,
): Promise<void> {
  const resolvedInput = resolveInputPath(fileName);

  // A wrong extension fails later with an internal Langium "service registry contains no services".
  const extensions: readonly string[] =
    BpmnScriptLanguageMetaData.fileExtensions;
  if (!extensions.includes(path.extname(resolvedInput))) {
    fail(
      2,
      `Error: expected a file with one of these extensions: ${extensions.join(', ')}; ` +
        'a .bpmn file is decompiled with `bpmns parse`',
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
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (errors.length > 0) {
    console.error(chalk.red('Validation errors:'));
    for (const diag of errors) {
      console.error(chalk.red(formatDiagnostic(document, diag)));
    }
    process.exit(1);
  }

  // After the error gate: a keyword typo also parses into a model with no processes.
  const ast = document.parseResult.value as Model;
  if (ast.processes.length === 0) fail(1, `Error: ${NO_PROCESS_MESSAGE}`);

  const warnings = (document.diagnostics ?? []).filter(
    (d) => d.severity === DiagnosticSeverity.Warning,
  );
  for (const diag of warnings) {
    warn(
      `Warning: line ${diag.range.start.line + 1}: ${Diagnostic.getMessageString(diag)}`,
    );
  }

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
    // Operaton deploys the document without a diagram.
    xml = err.xml;
    warn(
      `Warning: no diagram could be drawn for this process (${err.message}); the file deploys but opens without shapes in a modeler`,
    );
  }

  await writeOutput(outPath, xml);
  console.log(chalk.green(`Built: ${outPath}`));
}
