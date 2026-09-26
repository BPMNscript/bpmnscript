import chalk from 'chalk';
import * as fs from 'node:fs/promises';

import {
  xmlToIr,
  irToDsl,
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

// `moddle-xml`'s one message for a root that resolves to no registered type;
// it never says what it found.
const WRONG_ROOT_MESSAGE = 'failed to parse document as <bpmn:Definitions>';
const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

function describeRoot(xml: string): string {
  const tag = /<([\w:]+)/.exec(xml)?.[1];
  if (tag === undefined) return '';
  // A greedy `[^>]*` backtracks from the tag's end, so it lands on the last
  // xmlns declared on the root, not the one for the root's own prefix.
  const colon = tag.indexOf(':');
  const decl = colon === -1 ? 'xmlns' : `xmlns:${tag.slice(0, colon)}`;
  const uri = new RegExp(`<${tag}[^>]*?\\s${decl}="([^"]+)"`).exec(xml)?.[1];
  const found = uri === undefined ? '' : `; found ${decl}=${uri}`;
  return ` (root element is <${tag}>; expected <bpmn:definitions> in namespace ${BPMN_NAMESPACE}${found})`;
}

// `saxen`'s parse errors quote the unparsed remainder of the document after a
// newline: megabytes for a large or binary file, control characters included.
function readableParseError(message: string, xml: string): string {
  const firstLine = message.split('\n')[0];
  const capped = (
    firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine
  ).replace(/\p{C}/gu, '');
  return capped === WRONG_ROOT_MESSAGE ? capped + describeRoot(xml) : capped;
}

function printablePreview(text: string): string {
  return text.slice(0, 200).replace(/\p{C}/gu, '').slice(0, 40);
}

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

  // `trim` treats a leading BOM as whitespace (ECMA-262 WhiteSpace includes
  // U+FEFF), so neither check needs a BOM strip.
  if (xml.trim() === '') fail(2, 'Error: the file is empty');
  if (!xml.trimStart().startsWith('<')) {
    fail(
      2,
      `Error: not an XML document (starts with "${printablePreview(xml.trimStart())}"); ` +
        'a .bpmnscript file is built with `bpmns build`',
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

  // The print hop never refuses (ADR-0014) and none of the warnings above run
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
