// Runs a command the way `bpmns` does, minus the shell: a real file in and a
// real file out, with the exit code, the stderr lines and the written output
// handed back instead of leaving the process.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { expect, vi } from 'vitest';

import { buildAction } from '../../src/build.js';
import { parseAction } from '../../src/parse.js';

// Captured stderr is compared line for line, so the colouring must not vary
// with whether the runner happens to own a terminal.
chalk.level = 0;

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) was called`);
    this.name = 'ExitCalled';
  }
}

export type ActionRun = {
  /** The code the action exited with, or undefined where it ran to the end. */
  exit: number | undefined;
  /** Every line the action wrote to stderr, in order. */
  stderr: string[];
  /** The written file's content, or undefined where nothing was written. */
  output: string | undefined;
};

/** Either a source written into the temp dir, or a file already on disk. */
export type Input = { text: string } | { file: string };

type Action = (
  fileName: string,
  opts: { output?: string },
) => Promise<void | undefined>;

async function run(
  action: Action,
  inputExt: string,
  outputExt: string,
  input: Input,
): Promise<ActionRun> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-'));
  try {
    const inputPath =
      'file' in input ? input.file : path.join(dir, `input${inputExt}`);
    if ('text' in input) {
      await fsp.writeFile(inputPath, input.text, 'utf-8');
    }
    const outputPath = path.join(dir, `output${outputExt}`);

    const stderr: string[] = [];
    const spies = [
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        stderr.push(String(args[0]));
      }),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      // Throws so the action stops where process.exit() would have. A no-op
      // mock would let it fall through and keep running.
      vi.spyOn(process, 'exit').mockImplementation((code?: unknown) => {
        throw new ExitCalled(typeof code === 'number' ? code : 0);
      }),
    ];

    let exit: number | undefined;
    try {
      await action(inputPath, { output: outputPath });
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
      exit = err.code;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    return {
      exit,
      stderr,
      output: fs.existsSync(outputPath)
        ? await fsp.readFile(outputPath, 'utf-8')
        : undefined,
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Compiles a `.bpmnscript` source to BPMN, as `bpmns build` does. */
export const runBuild = (input: Input): Promise<ActionRun> =>
  run(buildAction, '.bpmnscript', '.bpmn', input);

/** Decompiles a `.bpmn` file to a script, as `bpmns parse` does. */
export const runParse = (input: Input): Promise<ActionRun> =>
  run(parseAction, '.bpmn', '.bpmnscript', input);

/** Every substring must appear in `text`, so a line that stops saying one fails. */
export function expectMentions(
  text: string,
  mentions: readonly string[],
): void {
  for (const mention of mentions) {
    expect(text, `expected to find "${mention}" in: ${text}`).toContain(
      mention,
    );
  }
}
