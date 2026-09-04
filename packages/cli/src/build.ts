import {
  createBpmnScriptServices,
  BpmnScriptLanguageMetaData,
} from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { astToIr, irToXml } from '@bpmn-script/transform';
import { CLI_VERSION, diagnosticMessage, resolveOutputPath } from './util.js';

export type BuildOptions = {
  output?: string;
};

const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

export async function buildAction(
  fileName: string,
  opts: BuildOptions,
): Promise<void> {
  const resolvedInput = path.resolve(fileName);

  if (!fsSync.existsSync(resolvedInput)) {
    console.error(chalk.red(`Error: file not found: ${fileName}`));
    process.exit(2);
  }

  const extensions: readonly string[] =
    BpmnScriptLanguageMetaData.fileExtensions;
  if (!extensions.includes(path.extname(resolvedInput))) {
    console.error(
      chalk.yellow(
        `Warning: expected a file with one of these extensions: ${extensions.join(', ')}`,
      ),
    );
  }

  const outPath = resolveOutputPath(resolvedInput, '.bpmn', opts.output);

  const services = createBpmnScriptServices(NodeFileSystem).BpmnScript;

  let document;
  try {
    document =
      await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(resolvedInput),
      );
    await services.shared.workspace.DocumentBuilder.build([document], {
      validation: true,
    });
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
      console.error(
        chalk.red(
          `  line ${diag.range.start.line + 1}: ${diagnosticMessage(diag)}` +
            ` [${document.textDocument.getText(diag.range)}]`,
        ),
      );
    }
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

  const ast = document.parseResult?.value as Model;

  let ir;
  try {
    ir = astToIr(ast);
  } catch (err) {
    console.error(
      chalk.red(
        `Error: AST to IR conversion failed: ${(err as Error).message}`,
      ),
    );
    process.exit(1);
  }

  let xml;
  try {
    xml = await irToXml(ir, {
      sourceFileName: path.basename(resolvedInput),
      exporterVersion: CLI_VERSION,
    });
  } catch (err) {
    console.error(
      chalk.red(
        `Error: IR to XML conversion failed: ${(err as Error).message}`,
      ),
    );
    process.exit(1);
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
