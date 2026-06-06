/**
 * BPMNscript CLI entry point.
 *
 * Exposes two subcommands:
 *
 *   bpmns build <file.bpmnscript> [-o <out.bpmn>]
 *     DSL → BPMN XML pipeline.
 *     Exit 0 on success, 1 on validation errors, 2 on I/O errors.
 *
 *   bpmns parse <file.bpmn> [-o <out.bpmnscript>]
 *     BPMN XML → DSL pipeline.
 *     Exit 0 on success, 1 on unsupported constructs, 2 on I/O errors.
 */

import { Command } from 'commander';

import { buildAction } from './build.js';
import { parseAction } from './parse.js';
import { CLI_VERSION } from './util.js';

export default function (): void {
  const program = new Command();

  program
    .name('bpmns')
    .version(CLI_VERSION)
    .description('BPMNscript — compile and decompile BPMN processes');

  // ── build ─────────────────────────────────────────────────────────────────
  program
    .command('build')
    .argument('<file>', 'path to the .bpmnscript source file')
    .option(
      '-o, --output <file>',
      'output .bpmn file path (default: same dir, same basename)',
    )
    .description('Compile a .bpmnscript source file to BPMN 2.0 XML')
    .action(buildAction);

  // ── parse ─────────────────────────────────────────────────────────────────
  program
    .command('parse')
    .argument('<file>', 'path to the .bpmn file')
    .option(
      '-o, --output <file>',
      'output .bpmnscript file path (default: same dir, same basename)',
    )
    .description('Decompile a BPMN 2.0 XML file to .bpmnscript DSL')
    .action(parseAction);

  program.parse(process.argv);
}
