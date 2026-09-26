// `vscode` is injected by the extension host, not installed from npm, so it
// has to be mocked with the surface the adapter touches. The conversion itself
// is mocked too: what is under test is the notification each outcome composes.

import { beforeEach, describe, expect, test, vi } from 'vitest';

// vi.mock factories are hoisted above the module body, so a plain top-level
// const would still be in its temporal dead zone here. vi.hoisted is required.
const mocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showTextDocument: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`,
    }),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage,
    showTextDocument: mocks.showTextDocument,
    showOpenDialog: vi.fn(),
  },
  commands: {
    executeCommand: mocks.executeCommand,
  },
  workspace: {
    textDocuments: [],
    fs: {
      readFile: vi.fn().mockResolvedValue(new Uint8Array()),
      writeFile: vi.fn().mockResolvedValue(undefined),
      // Rejecting sends confirmOverwrite down its "nothing to overwrite"
      // branch, so no row below hits the modal.
      stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
    },
  },
}));

vi.mock('../src/extension/conversion-core.js', () => ({
  compileDslToBpmn: vi.fn(),
  decompileBpmnToDsl: vi.fn(),
  swapExtension: (fsPath: string, newExt: string) =>
    fsPath.replace(/\.[^./]+$/, newExt),
}));

import * as vscode from 'vscode';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
} from '../src/extension/conversion-core.js';
import type {
  CompileResult,
  DecompileResult,
} from '../src/extension/conversion-core.js';
import {
  compileCommand,
  decompileCommand,
} from '../src/extension/conversion.js';

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The first argument of every notification the run raised, by severity. */
function notifications(): Record<'info' | 'warning' | 'error', string[]> {
  const firstArgs = (fn: { mock: { calls: unknown[][] } }): string[] =>
    fn.mock.calls.map((call) => String(call[0]));
  return {
    info: firstArgs(mocks.showInformationMessage),
    warning: firstArgs(mocks.showWarningMessage),
    error: firstArgs(mocks.showErrorMessage),
  };
}

/** The fsPath of every document the run opened, in call order. */
function shownDocuments(): string[] {
  return mocks.showTextDocument.mock.calls.map(
    (call) => (call[0] as vscode.Uri).fsPath,
  );
}

/** The first argument of every editor command the run executed. */
function executedCommands(): string[] {
  return mocks.executeCommand.mock.calls.map((call) => String(call[0]));
}

// Neither message names its own element: they say "here" and leave the id to
// the caller, so unrendered they arrive as one line repeated.
const SAME_WORDING =
  'The model weighs the route on from here with a condition, ' +
  'which the script leaves out.';

type Expected = {
  info?: string[];
  warning?: string[];
  error?: string[];
  /** The uri the command returns, or undefined where it gives up. */
  returns: string | undefined;
  /** Every document opened via showTextDocument, in call order. */
  shown?: string[];
  /** Every editor command executed, in call order. */
  executed?: string[];
};

type Row = readonly [
  title: string,
  command: 'compile' | 'decompile',
  /** Basename of the source file the row hands the command. */
  sourceName: string,
  // undefined means the guard refuses the file before the core ever runs.
  result: CompileResult | DecompileResult | undefined,
  expected: Expected,
];

describe('conversion commands: what the author is shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each<Row>([
    [
      'a decompile that dropped something names the file once and the dropped item after it',
      'decompile',
      'example.bpmn',
      {
        ok: true,
        output: 'process P { start S end E }',
        warnings: [
          {
            elementId: 'Task1',
            category: 'extensionAttribute',
            message:
              "The 'formHandlerClass' setting on 'Task1' was not imported",
          },
        ],
      },
      {
        info: ['BPMNscript: Decompiled "example.bpmn" -> "example.bpmnscript"'],
        warning: [
          'BPMNscript: "example.bpmn" reported 1 item(s) during decompile: ' +
            "Task1: The 'formHandlerClass' setting on 'Task1' was not imported",
        ],
        returns: '/tmp/example.bpmnscript',
        shown: ['/tmp/example.bpmnscript'],
      },
    ],
    [
      'two same-worded warnings are told apart by the element each is about',
      'decompile',
      'example.bpmn',
      {
        ok: true,
        output: 'process P { start S end E }',
        warnings: [
          {
            elementId: 'CheckStock',
            category: 'droppedCondition',
            message: SAME_WORDING,
          },
          {
            elementId: 'ReserveGoods',
            category: 'droppedCondition',
            message: SAME_WORDING,
          },
        ],
      },
      {
        info: ['BPMNscript: Decompiled "example.bpmn" -> "example.bpmnscript"'],
        warning: [
          'BPMNscript: "example.bpmn" reported 2 item(s) during decompile: ' +
            `CheckStock: ${SAME_WORDING}; ReserveGoods: ${SAME_WORDING}`,
        ],
        returns: '/tmp/example.bpmnscript',
        shown: ['/tmp/example.bpmnscript'],
      },
    ],
    [
      'a refused construct is reported as an error naming the file once, and nothing is written',
      'decompile',
      'example.bpmn',
      {
        ok: false,
        kind: 'unsupported',
        message: 'multiple linked processes (pools and message flows).',
      },
      {
        error: [
          'BPMNscript: "example.bpmn" contains an unsupported construct: ' +
            'multiple linked processes (pools and message flows).',
        ],
        returns: undefined,
      },
    ],
    [
      'a validation failure focuses the Problems panel and reports the count',
      'compile',
      'example.bpmnscript',
      {
        ok: false,
        kind: 'validation',
        diagnostics: [
          {
            line: 0,
            character: 0,
            endLine: 0,
            endCharacter: 1,
            message: 'bad',
            severity: 1,
            text: 'x',
          },
        ],
      },
      {
        error: [
          'BPMNscript: "example.bpmnscript" has 1 compilation error(s). See the Problems panel.',
        ],
        returns: undefined,
        shown: ['/tmp/example.bpmnscript'],
        executed: ['workbench.action.problems.focus'],
      },
    ],
    [
      'an unexpected failure is reported as an error naming the file once',
      'compile',
      'example.bpmnscript',
      { ok: false, kind: 'error', message: 'boom' },
      {
        error: ['BPMNscript: Failed to compile "example.bpmnscript": boom'],
        returns: undefined,
      },
    ],
    [
      'compile refuses a file that is not a script',
      'compile',
      'example.bpmn',
      undefined,
      {
        warning: [
          'BPMNscript: "example.bpmn" is not a .bpmnscript file; ' +
            'use "Decompile to BPMNscript" for it.',
        ],
        returns: undefined,
      },
    ],
    [
      'decompile refuses a file that is not BPMN',
      'decompile',
      'example.bpmnscript',
      undefined,
      {
        warning: [
          'BPMNscript: "example.bpmnscript" is not a .bpmn file; ' +
            'use "Compile to BPMN" for it.',
        ],
        returns: undefined,
      },
    ],
    [
      'compile takes an upper-case extension',
      'compile',
      'ORDER.BPMNSCRIPT',
      { ok: true, output: 'process P { start S end E }' },
      {
        info: ['BPMNscript: Compiled "ORDER.BPMNSCRIPT" -> "ORDER.bpmn"'],
        returns: '/tmp/ORDER.bpmn',
        shown: ['/tmp/ORDER.bpmn'],
      },
    ],
  ])('%s', async (_title, command, sourceName, result, expected) => {
    let handler: (uri?: vscode.Uri) => Promise<vscode.Uri | undefined>;
    if (command === 'compile') {
      if (result) {
        vi.mocked(compileDslToBpmn).mockResolvedValue(result as CompileResult);
      }
      handler = compileCommand('0.0.1');
    } else {
      if (result) {
        vi.mocked(decompileBpmnToDsl).mockResolvedValue(
          result as DecompileResult,
        );
      }
      handler = decompileCommand();
    }

    const returned = await handler(vscode.Uri.file(`/tmp/${sourceName}`));

    const {
      info = [],
      warning = [],
      error = [],
      shown = [],
      executed = [],
    } = expected;
    expect(returned?.fsPath).toBe(expected.returns);
    expect(notifications()).toEqual({ info, warning, error });
    expect(shownDocuments()).toEqual(shown);
    expect(executedCommands()).toEqual(executed);

    const core = command === 'compile' ? compileDslToBpmn : decompileBpmnToDsl;
    expect(core).toHaveBeenCalledTimes(result === undefined ? 0 : 1);

    // The file is named once per line. The success line is the exception: it
    // names the file it read and the file it wrote.
    for (const message of [...warning, ...error]) {
      expect(occurrences(message, sourceName)).toBe(1);
    }
  });
});
