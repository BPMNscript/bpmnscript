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
 *   0  — success (non-fatal import warnings, if any, are printed to stderr
 *         but do not change the exit code)
 *   1  — unsupported BPMN construct (any UnsupportedConstructError subclass:
 *         UnsupportedServiceTaskFormError, UnsupportedElementError,
 *         UnsupportedEventDefinitionError, UnsupportedEventFeatureError,
 *         UnsupportedLoopCharacteristicsError, UnsupportedCollaborationError,
 *         UnsupportedCallActivityError)
 *   2  — I/O errors (file not found, cannot write output)
 */

import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
  xmlToIr,
  irToDsl,
  UNSTRUCTURED_MARKER,
  UnsupportedConstructError,
  UnsupportedServiceTaskFormError,
  UnsupportedElementError,
} from '@bpmn-script/transform';
import type { ImportWarning } from '@bpmn-script/transform';
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
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    if (err instanceof UnsupportedServiceTaskFormError) {
      console.error(
        chalk.red(
          `Error: unsupported service task form in ${fileName}:\n` +
            `  Service task '${err.serviceTaskId}' uses '${err.construct}'.\n` +
            '  Supported forms are a Java class (operaton:class, or the deprecated ' +
            'camunda:class alias), an expression, a delegate expression, or an ' +
            'external task topic.',
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
      // Remaining refusal subclasses; each message already names the
      // offending construct and element.
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

  // ── 7. Surface non-fatal import warnings ────────────────────────────────
  // Warnings go to stderr and do not change the exit code.
  for (const w of warnings) {
    console.error(chalk.yellow(`Warning: ${w.message}`));
  }

  // An edge the decompiler could not express leaves a marker comment in the
  // output, naming the element the edge led into. Ordinary BPMN reaches this —
  // a loop whose condition sits on the back-edge is the common case — so the
  // warning has to be loud: that edge is gone from the decompiled model and
  // only a human can put the control flow back. The output is still written
  // (the marker keeps it parseable) and the exit code is unchanged.
  if (dsl.includes(UNSTRUCTURED_MARKER)) {
    console.error(
      chalk.yellow(
        'Warning: the decompiled model contains an unstructured region that needs hand-repair (see the marker comment). At least one sequence flow could not be expressed and was dropped.',
      ),
    );
  }
}
