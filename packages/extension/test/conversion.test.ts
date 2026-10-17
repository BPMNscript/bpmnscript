// `vscode` is injected by the extension host, not installed from npm.

import { beforeEach, describe, expect, test, vi } from 'vitest';

// vi.mock factories are hoisted above a plain top-level const.
const mocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  appendLine: vi.fn(),
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
    createOutputChannel: () => ({
      appendLine: mocks.appendLine,
      show: vi.fn(),
    }),
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

vi.mock('../src/extension/conversion-core.js', async (importOriginal) => ({
  ...(await importOriginal()),
  compileDslToBpmn: vi.fn(),
  decompileBpmnToDsl: vi.fn(),
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
  pickBpmnAndDecompileCommand,
} from '../src/extension/conversion.js';

function notifications(): Record<'info' | 'warning' | 'error', string[]> {
  const firstArgs = (fn: { mock: { calls: unknown[][] } }): string[] =>
    fn.mock.calls.map((call) => String(call[0]));
  return {
    info: firstArgs(mocks.showInformationMessage),
    warning: firstArgs(mocks.showWarningMessage),
    error: firstArgs(mocks.showErrorMessage),
  };
}

function shownDocuments(): string[] {
  return mocks.showTextDocument.mock.calls.map(
    (call) => (call[0] as vscode.Uri).fsPath,
  );
}

function outputLines(): string[] {
  return mocks.appendLine.mock.calls.map((call) => String(call[0]));
}

function executedCommands(): string[] {
  return mocks.executeCommand.mock.calls.map((call) => String(call[0]));
}

const DROPPED = (id: string): string =>
  `condition '\${ok}' on the route out of '${id}' was dropped\n` +
  'note: when the condition is false, Operaton stops the original process with an error';

type Expected = {
  info?: string[];
  warning?: string[];
  error?: string[];
  returns: string | undefined;
  shown?: string[];
  executed?: string[];
  /** Lines written to the output channel, where note and help lines keep their own line. */
  output?: string[];
};

type Row = readonly [
  title: string,
  command: 'compile' | 'decompile',
  // undefined: no uri and no active editor.
  sourceName: string | undefined,
  // undefined: refused before the core runs.
  result: CompileResult | DecompileResult | undefined,
  expected: Expected,
];

describe('conversion commands: what the author is shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each<Row>([
    [
      'a decompile that dropped things names the file once and each dropped item by its element',
      'decompile',
      'example.bpmn',
      {
        ok: true,
        output: 'process P { start S end E }',
        warnings: [
          {
            elementId: 'CheckStock',
            category: 'droppedCondition',
            message: DROPPED('CheckStock'),
          },
          {
            elementId: 'ReserveGoods',
            category: 'droppedCondition',
            message: DROPPED('ReserveGoods'),
          },
        ],
        buildErrors: [
          {
            line: 2,
            character: 0,
            endLine: 2,
            endCharacter: 4,
            message: 'bad default\nnote: it is not an integer',
            severity: 1,
            text: 'done',
          },
        ],
      },
      {
        info: ['BPMNscript: Decompiled "example.bpmn" -> "example.bpmnscript"'],
        warning: [
          'BPMNscript: "example.bpmn" reported 2 item(s) during decompile.',
          'BPMNscript: The script decompiled from "example.bpmn" has 1 compilation error(s) and needs hand-repair.',
        ],
        output: [
          'BPMNscript: "example.bpmn" reported 2 item(s) during decompile.',
          "  condition '${ok}' on the route out of 'CheckStock' was dropped\n" +
            '    note: when the condition is false, Operaton stops the original process with an error',
          "  condition '${ok}' on the route out of 'ReserveGoods' was dropped\n" +
            '    note: when the condition is false, Operaton stops the original process with an error',
          'BPMNscript: The script decompiled from "example.bpmn" has 1 compilation error(s) and needs hand-repair.',
          '  line 3: bad default\n    note: it is not an integer',
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
        message:
          "the file contains two executable processes ('a', 'b')\n" +
          'note: BPMNscript imports one process',
      },
      {
        error: [
          'BPMNscript: "example.bpmn" cannot be decompiled: ' +
            "the file contains two executable processes ('a', 'b')",
        ],
        output: [
          'BPMNscript: "example.bpmn" cannot be decompiled: ' +
            "the file contains two executable processes ('a', 'b')",
          '  note: BPMNscript imports one process',
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
      'decompile refuses a file that is not BPMN',
      'decompile',
      'example.bpmnscript',
      undefined,
      {
        warning: [
          'BPMNscript: "example.bpmnscript" is not a .bpmn file. ' +
            'Use "Compile to BPMN" for it.',
        ],
        returns: undefined,
      },
    ],
    [
      'compile with nothing selected and no editor open says so and stops',
      'compile',
      undefined,
      undefined,
      {
        warning: [
          'BPMNscript: No file selected. Open a .bpmnscript file or select one in the Explorer.',
        ],
        returns: undefined,
      },
    ],
    [
      'decompile with nothing selected and no editor open says so and stops',
      'decompile',
      undefined,
      undefined,
      {
        warning: [
          'BPMNscript: No file selected. Open a .bpmn file or select one in the Explorer.',
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

    const returned = await handler(
      sourceName === undefined
        ? undefined
        : vscode.Uri.file(`/tmp/${sourceName}`),
    );

    const {
      info = [],
      warning = [],
      error = [],
      shown = [],
      executed = [],
      output = [],
    } = expected;
    expect(returned?.fsPath).toBe(expected.returns);
    expect(notifications()).toEqual({ info, warning, error });
    expect(shownDocuments()).toEqual(shown);
    expect(executedCommands()).toEqual(executed);
    expect(outputLines()).toEqual(output);

    const core = command === 'compile' ? compileDslToBpmn : decompileBpmnToDsl;
    expect(core).toHaveBeenCalledTimes(result === undefined ? 0 : 1);
  });
});

describe('conversion commands: what reaches the disk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(compileDslToBpmn).mockResolvedValue({
      ok: true,
      output: '<bpmn/>',
    });
  });

  test('unsaved edits are converted, not the stale file on disk', async () => {
    const uri = vscode.Uri.file('/tmp/example.bpmnscript');
    const openDocs = vscode.workspace.textDocuments as vscode.TextDocument[];
    openDocs.push({ uri, getText: () => 'EDITED' } as vscode.TextDocument);
    try {
      await compileCommand('0.0.1')(uri);
    } finally {
      openDocs.length = 0;
    }
    expect(compileDslToBpmn).toHaveBeenCalledWith('EDITED', '0.0.1');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  test.each([
    ['declining the prompt writes nothing', undefined, undefined, 0],
    [
      "answering 'Overwrite' writes the output",
      'Overwrite',
      '/tmp/example.bpmn',
      1,
    ],
  ])('an existing output: %s', async (_title, answer, returns, writes) => {
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValueOnce(
      {} as vscode.FileStat,
    );
    mocks.showWarningMessage.mockResolvedValueOnce(answer);

    const returned = await compileCommand('0.0.1')(
      vscode.Uri.file('/tmp/example.bpmnscript'),
    );

    expect(returned?.fsPath).toBe(returns);
    expect(notifications().warning).toEqual([
      '"/tmp/example.bpmn" already exists. Overwrite?',
    ]);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(writes);
  });

  test.each([
    ['a cancelled dialog decompiles nothing', undefined, []],
    [
      'the picked file is decompiled',
      [vscode.Uri.file('/tmp/example.bpmn')],
      ['/tmp/example.bpmn'],
    ],
  ])('open and decompile: %s', async (_title, picked, decompiled) => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(picked);
    const decompile = vi.fn();

    await pickBpmnAndDecompileCommand(decompile)();

    expect(
      decompile.mock.calls.map((call) => (call[0] as vscode.Uri).fsPath),
    ).toEqual(decompiled);
  });
});
