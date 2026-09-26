import chalk from 'chalk';
import * as fs from 'node:fs/promises';

import {
  xmlToIr,
  irToDsl,
  EMPTY_INPUT_MESSAGE,
  readableParseError,
  xmlInputProblem,
  UnsupportedConstructError,
  UnsupportedServiceTaskFormError,
  UnsupportedElementError,
} from '@bpmn-script/transform';
import type { ImportWarning, PrintWarning } from '@bpmn-script/transform';
import {
  SEVERITY_ERROR,
  buildDocument,
  fail,
  formatDiagnostic,
  guardOutputPath,
  resolveInputPath,
  resolveOutputPath,
  warn,
  writeOutput,
} from './util.js';

type ParseOptions = {
  output?: string;
  force?: boolean;
};

export async function parseAction(
  fileName: string,
  opts: ParseOptions,
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
      `Error: ${problem}; a .bpmnscript file is built with \`bpmns build\``,
    );
  }

  let ir;
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    // Subclasses first: they all extend UnsupportedConstructError.
    if (err instanceof UnsupportedServiceTaskFormError) {
      fail(
        1,
        `Error: unsupported ${err.subject.toLowerCase()} form in ${fileName}:\n` +
          `  ${err.message}\n` +
          '  The attributes are operaton:class (or the deprecated camunda:class ' +
          'alias), operaton:expression, operaton:delegateExpression, ' +
          'operaton:type="external" with operaton:topic, ' +
          'operaton:type="mail" or "shell" with their operaton:field ' +
          'children, and operaton:decisionRef.',
      );
    }
    if (err instanceof UnsupportedElementError) {
      fail(
        1,
        `Error: unsupported BPMN element in ${fileName}:\n  ${err.message}`,
      );
    }
    if (err instanceof UnsupportedConstructError) {
      fail(
        1,
        `Error: unsupported BPMN construct in ${fileName}:\n  ${err.message}`,
      );
    }
    fail(
      2,
      `Error: failed to parse ${fileName}: ` +
        readableParseError((err as Error).message, xml),
    );
  }

  let dsl: string;
  let printWarnings: PrintWarning[];
  try {
    ({ source: dsl, warnings: printWarnings } = irToDsl(ir));
  } catch (err) {
    fail(2, `Error: ${(err as Error).message}`);
  }

  await writeOutput(outPath, dsl);
  console.log(chalk.green(`Parsed: ${outPath}`));

  // The id leads because several messages do not name their step, so two of
  // them would otherwise print as the same line.
  for (const w of [...warnings, ...printWarnings]) {
    warn(`Warning: ${w.elementId}: ${w.message}`);
  }

  // The print hop never refuses and none of the warnings above run
  // the validator, so a setting carried as written may still draw an error;
  // building the written script the way `build` would is what catches it.
  const rebuilt = await buildDocument(outPath);
  const buildErrors = (rebuilt.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_ERROR,
  );
  if (buildErrors.length > 0) {
    warn(
      `Warning: the printed script draws ${buildErrors.length} error(s) ` +
        'when built; hand-repair is needed:',
    );
    for (const diag of buildErrors) {
      warn(formatDiagnostic(rebuilt, diag));
    }
  }
}
