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
import {
  SEVERITY_ERROR,
  buildDocument,
  formatDiagnostic,
  guardOutputPath,
  refuseDirectoryInput,
  resolveOutputPath,
} from './util.js';

export type ParseOptions = {
  output?: string;
  force?: boolean;
};

// The one message `moddle-xml`'s reader gives when the root element does not
// resolve to any registered type, bpmn:Definitions included: it never says
// what it found (`moddle-xml`'s `Reader`, root-handler branch).
const WRONG_ROOT_MESSAGE = 'failed to parse document as <bpmn:Definitions>';
const BPMN_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

/** The tag name and, where present, the xmlns declaration on that same tag. */
function describeRoot(xml: string): string {
  const tag = /<([\w:]+)/.exec(xml)?.[1];
  if (tag === undefined) return '';
  // A greedy `[^>]*` backtracks from the tag's end, so it lands on the LAST
  // xmlns declared on the root, not the one for the root's own prefix.
  const colon = tag.indexOf(':');
  const decl = colon === -1 ? 'xmlns' : `xmlns:${tag.slice(0, colon)}`;
  const uri = new RegExp(`<${tag}[^>]*?\\s${decl}="([^"]+)"`).exec(xml)?.[1];
  const found = uri === undefined ? '' : `; found ${decl}=${uri}`;
  return ` (root element is <${tag}>; expected <bpmn:definitions> in namespace ${BPMN_NAMESPACE}${found})`;
}

/**
 * `saxen`'s parse errors quote the unparsed remainder of the document, which
 * for a large or binary file is megabytes on stderr, control characters
 * included when the remainder holds any. Cut at the first line (the
 * remainder trails after a real newline in the message), cap and drop
 * control characters from what's left, then add whatever root-mismatch
 * detail applies.
 */
function readableParseError(message: string, xml: string): string {
  const firstLine = message.split('\n')[0];
  const capped = (
    firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine
  ).replace(/\p{C}/gu, '');
  // The root-mismatch hint is added after capping: it is bounded by the
  // document's own tag and namespace text, not by the remainder a malformed
  // document can dump into the message this replaces.
  return capped === WRONG_ROOT_MESSAGE ? capped + describeRoot(xml) : capped;
}

/** The first 40 characters with control characters stripped, for previewing a non-XML file without dumping it. */
function printablePreview(text: string): string {
  return text.slice(0, 200).replace(/\p{C}/gu, '').slice(0, 40);
}

export async function parseAction(
  fileName: string,
  opts: ParseOptions,
): Promise<void> {
  const resolvedInput = path.resolve(fileName);

  if (!fsSync.existsSync(resolvedInput)) {
    console.error(chalk.red(`Error: file not found: ${fileName}`));
    process.exit(2);
  }
  refuseDirectoryInput(resolvedInput, fileName);

  const outPath = resolveOutputPath(resolvedInput, '.bpmnscript', opts.output);
  guardOutputPath(resolvedInput, outPath, opts);

  let xml: string;
  try {
    xml = await fs.readFile(resolvedInput, 'utf-8');
  } catch (err) {
    console.error(
      chalk.red(`Error: could not read ${fileName}: ${(err as Error).message}`),
    );
    process.exit(2);
  }

  // `trim`/`trimStart` treat a leading BOM as whitespace (ECMA-262 WhiteSpace
  // includes U+FEFF), so an empty-or-BOM-only file and one indented under a
  // BOM both fall through this pair of checks correctly with no extra strip.
  if (xml.trim() === '') {
    console.error(chalk.red('Error: the file is empty'));
    process.exit(2);
  }
  if (!xml.trimStart().startsWith('<')) {
    console.error(
      chalk.red(
        `Error: not an XML document (starts with "${printablePreview(xml.trimStart())}"); ` +
          'a .bpmnscript file is built with `bpmns build`',
      ),
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
            'operaton:type="external" with operaton:topic, ' +
            'operaton:type="mail" or "shell" with their operaton:field ' +
            'children, and operaton:decisionRef.',
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
        `Error: failed to parse ${fileName}: ` +
          readableParseError((err as Error).message, xml),
      ),
    );
    process.exit(2);
  }

  let dsl: string;
  let printWarnings: PrintWarning[];
  try {
    ({ source: dsl, warnings: printWarnings } = irToDsl(ir));
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
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

  // The print hop from IR to source never refuses (ADR-0014): a warning above
  // can name that a setting was carried as written, but none of them run the
  // validator, so whether it actually draws an error is still unconfirmed.
  // Re-running the same document-builder path `build` uses over the script
  // just written is the one place that can still catch it, for every shape.
  const rebuilt = await buildDocument(outPath);
  const buildErrors = (rebuilt.diagnostics ?? []).filter(
    (d) => d.severity === SEVERITY_ERROR,
  );
  if (buildErrors.length > 0) {
    console.error(
      chalk.yellow(
        `Warning: the printed script draws ${buildErrors.length} error(s) ` +
          'when built; hand-repair is needed:',
      ),
    );
    for (const diag of buildErrors) {
      console.error(chalk.yellow(formatDiagnostic(rebuilt, diag)));
    }
  }
}
