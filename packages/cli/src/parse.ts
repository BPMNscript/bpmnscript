import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
  xmlToIr,
  irToDsl,
  UnsupportedConstructError,
  UnsupportedServiceTaskFormError,
  UnsupportedElementError,
} from '@bpmn-script/transform';
import type { ImportWarning, PrintWarning } from '@bpmn-script/transform';
import { resolveOutputPath } from './util.js';

export type ParseOptions = {
  output?: string;
};

export async function parseAction(
  fileName: string,
  opts: ParseOptions,
): Promise<void> {
  const resolvedInput = path.resolve(fileName);

  if (!fsSync.existsSync(resolvedInput)) {
    console.error(chalk.red(`Error: file not found: ${fileName}`));
    process.exit(2);
  }

  const outPath = resolveOutputPath(resolvedInput, '.bpmnscript', opts.output);

  let xml: string;
  try {
    xml = await fs.readFile(resolvedInput, 'utf-8');
  } catch (err) {
    console.error(
      chalk.red(`Error: could not read ${fileName}: ${(err as Error).message}`),
    );
    process.exit(2);
  }

  let ir;
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    // Subclasses first: they all extend UnsupportedConstructError.
    if (err instanceof UnsupportedServiceTaskFormError) {
      console.error(
        chalk.red(
          `Error: unsupported ${err.subject.toLowerCase()} form in ${fileName}:\n` +
            `  ${err.message}\n` +
            '  The attributes are operaton:class (or the deprecated camunda:class ' +
            'alias), operaton:expression, operaton:delegateExpression, ' +
            'operaton:type="external" with operaton:topic, and ' +
            'operaton:decisionRef.',
        ),
      );
      process.exit(1);
    }
    if (err instanceof UnsupportedElementError) {
      console.error(
        chalk.red(
          `Error: unsupported BPMN element in ${fileName}:\n` +
            `  ${err.message}`,
        ),
      );
      process.exit(1);
    }
    if (err instanceof UnsupportedConstructError) {
      console.error(
        chalk.red(
          `Error: unsupported BPMN construct in ${fileName}:\n` +
            `  ${err.message}`,
        ),
      );
      process.exit(1);
    }
    console.error(
      chalk.red(
        `Error: failed to parse ${fileName}: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  let dsl: string;
  let printWarnings: PrintWarning[];
  try {
    ({ source: dsl, warnings: printWarnings } = irToDsl(ir));
  } catch (err) {
    console.error(
      chalk.red(
        `Error: IR to DSL conversion failed: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  try {
    const outDir = path.dirname(outPath);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(outPath, dsl, 'utf-8');
  } catch (err) {
    console.error(
      chalk.red(
        `Error: could not write output to ${outPath}: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  console.log(chalk.green(`Parsed: ${outPath}`));

  // The id leads: several messages describe the route on from a step without
  // naming it, and two such warnings are otherwise the same line twice. The id
  // is also a token the reader can search for in the script just written.
  for (const w of [...warnings, ...printWarnings]) {
    console.error(chalk.yellow(`Warning: ${w.elementId}: ${w.message}`));
  }
}
