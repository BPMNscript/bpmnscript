/**
 * `bpmns parse` action.
 *
 * Drives the BPMN XML → DSL pipeline:
 *
 *   .bpmn  ──read file──►  XML string
 *          ──xmlToIr──►  IR
 *          ──irToDsl──►  .bpmnscript source string
 *          ──write to disk──►  .bpmnscript file
 *
 * Exit codes:
 *   0  — success
 *   1  — unsupported BPMN construct (UnsupportedServiceTaskFormError or
 *         UnsupportedElementError)
 *   2  — I/O errors (file not found, cannot write output)
 */

import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
  xmlToIr,
  irToDsl,
  UnsupportedServiceTaskFormError,
  UnsupportedElementError,
} from '@bpmn-script/transform';
import { resolveOutputPath } from './util.js';

export type ParseOptions = {
  output?: string;
};

/**
 * Execute the `parse` subcommand.
 *
 * @param fileName  Path to the `.bpmn` source file (relative or absolute).
 * @param opts      Command options. `opts.output` overrides the default output path.
 */
export async function parseAction(
  fileName: string,
  opts: ParseOptions,
): Promise<void> {
  // ── 1. Validate the input file exists ────────────────────────────────────
  const resolvedInput = path.resolve(fileName);

  if (!fsSync.existsSync(resolvedInput)) {
    console.error(chalk.red(`Error: file not found: ${fileName}`));
    process.exit(2);
  }

  // ── 2. Determine output path ──────────────────────────────────────────────
  const outPath = resolveOutputPath(resolvedInput, '.bpmnscript', opts.output);

  // ── 3. Read the BPMN XML file ─────────────────────────────────────────────
  let xml: string;
  try {
    xml = await fs.readFile(resolvedInput, 'utf-8');
  } catch (err) {
    console.error(
      chalk.red(`Error: could not read ${fileName}: ${(err as Error).message}`),
    );
    process.exit(2);
  }

  // ── 4. XML → IR ──────────────────────────────────────────────────────────
  let ir;
  try {
    ir = await xmlToIr(xml);
  } catch (err) {
    if (err instanceof UnsupportedServiceTaskFormError) {
      console.error(
        chalk.red(
          `Error: unsupported service task form in ${fileName}:\n` +
            `  Service task '${err.serviceTaskId}' uses '${err.construct}'.\n` +
            '  Only operaton:class (or the deprecated camunda:class alias) is supported.',
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
    console.error(
      chalk.red(
        `Error: failed to parse ${fileName}: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  // ── 5. IR → DSL ──────────────────────────────────────────────────────────
  let dsl: string;
  try {
    dsl = irToDsl(ir);
  } catch (err) {
    console.error(
      chalk.red(
        `Error: IR to DSL conversion failed: ${(err as Error).message}`,
      ),
    );
    process.exit(2);
  }

  // ── 6. Write output ───────────────────────────────────────────────────────
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
}
