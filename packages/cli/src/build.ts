import { BpmnScriptLanguageMetaData } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { astToIr, irToXml, LayoutError } from '@bpmn-script/transform';
import {
  CLI_VERSION,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  buildDocument,
  diagnosticMessage,
  formatDiagnostic,
  guardOutputPath,
  refuseDirectoryInput,
  resolveOutputPath,
} from './util.js';

export type BuildOptions = {
  output?: string;
  force?: boolean;
};

export async function buildAction(
  fileName: string,
  opts: BuildOptions,
): Promise<void> {
  const resolvedInput = path.resolve(fileName);

  if (!fsSync.existsSync(resolvedInput)) {
    console.error(chalk.red(`Error: file not found: ${fileName}`));
    process.exit(2);
  }
  refuseDirectoryInput(resolvedInput, fileName);

  // The document loader below picks its language service by extension, so a
  // wrong one cannot merely warn: it fails a few lines later with an internal
  // Langium message ("service registry contains no services").
  const extensions: readonly string[] =
    BpmnScriptLanguageMetaData.fileExtensions;
  if (!extensions.includes(path.extname(resolvedInput))) {
    console.error(
      chalk.red(
        `Error: expected a file with one of these extensions: ${extensions.join(', ')}`,
      ),
    );
    process.exit(2);
  }

  const outPath = resolveOutputPath(resolvedInput, '.bpmn', opts.output);
  guardOutputPath(resolvedInput, outPath, opts);

  let document;
  try {
    document = await buildDocument(resolvedInput);
  } catch (err) {
    console.error(
      chalk.red(
        `Error: failed to parse ${fileName}: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
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

  // A comment-only or blank source parses without error into a model with no
  // processes; catching that here, on the parsed model, keeps this message
  // for every such case instead of leaking astToIr's own internal wording.
  // Checked only once the document is error-free, so a keyword typo (which
  // also yields zero Process nodes) reports its real parser error instead.
  const ast = document.parseResult?.value as Model;
  if (ast.processes.length === 0) {
    console.error(chalk.red('Error: the file has no process'));
    process.exit(1);
  }

  const warnings = (document.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_WARNING,
  );
  for (const diag of warnings) {
    console.error(
      chalk.yellow(
        `Warning: line ${diag.range.start.line + 1}: ${diagnosticMessage(diag)}`,
      ),
    );
  }

  let ir;
  try {
    ir = astToIr(ast);
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  let xml: string;
  try {
    xml = await irToXml(ir, { exporterVersion: CLI_VERSION });
  } catch (err) {
    if (!(err instanceof LayoutError)) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
    // The document itself is fine (Operaton deploys it); only the auto-layout
    // step failed, so the file is written without a diagram instead of lost.
    xml = err.xml;
    console.error(
      chalk.yellow(
        `Warning: no diagram could be drawn for this process (${err.message}); the file deploys but opens without shapes in a modeler`,
      ),
    );
  }

  try {
    const outDir = path.dirname(outPath);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(outPath, xml, 'utf-8');
  } catch (err) {
    console.error(
      chalk.red(
        `Error: could not write output to ${outPath}: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  console.log(chalk.green(`Built: ${outPath}`));
}
