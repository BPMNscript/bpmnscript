import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { expect, vi } from 'vitest';

import { buildAction } from '../../src/build.js';
import { parseAction } from '../../src/parse.js';
import type { CommandOptions } from '../../src/util.js';

// Stderr is compared line for line, so colour must not depend on a TTY.
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
  stderr: string[];
  output: string | undefined;
};

export type Input = { text: string } | { file: string };

type Action = (
  fileName: string,
  opts: CommandOptions,
) => Promise<void | undefined>;

async function capture(
  invoke: () => Promise<void | undefined>,
): Promise<Pick<ActionRun, 'exit' | 'stderr'>> {
  const stderr: string[] = [];
  const spies = [
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(String(args[0]));
    }),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    // A no-op mock would let the action run on past the exit.
    vi.spyOn(process, 'exit').mockImplementation((code?: unknown) => {
      throw new ExitCalled(typeof code === 'number' ? code : 0);
    }),
  ];

  let exit: number | undefined;
  try {
    await invoke();
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    exit = err.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { exit, stderr };
}

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

    const { exit, stderr } = await capture(() =>
      action(inputPath, { output: outputPath }),
    );

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

/** Runs on caller-owned paths: nothing is invented or cleaned up. */
export const runActionAt = (
  action: 'build' | 'parse',
  inputPath: string,
  opts: CommandOptions,
): Promise<Pick<ActionRun, 'exit' | 'stderr'>> =>
  capture(() =>
    (action === 'build' ? buildAction : parseAction)(inputPath, opts),
  );

export const runBuild = (input: Input): Promise<ActionRun> =>
  run(buildAction, '.bpmnscript', '.bpmn', input);

export const runParse = (input: Input): Promise<ActionRun> =>
  run(parseAction, '.bpmn', '.bpmnscript', input);

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
