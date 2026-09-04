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
}));

vi.mock('vscode', () => {
  class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number,
    ) {}
  }
  class Diagnostic {
    constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }
  return {
    Range,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
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
  };
});

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

// `set` is overloaded in the real API, so the spy is declared with the
// two-argument form the adapter uses and the recorded calls stay readable.
function fakeDiagnosticCollection() {
  const set =
    vi.fn<(uri: vscode.Uri, published: vscode.Diagnostic[]) => void>();
  const cleared = vi.fn<(uri: vscode.Uri) => void>();
  return {
    collection: {
      set,
      delete: cleared,
    } as unknown as vscode.DiagnosticCollection,
    set,
    cleared,
  };
}

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
  /** The diagnostics published per `set` call, `[]` where none is expected. */
  published?: vscode.Diagnostic[][];
};

type Row = readonly [
  title: string,
  command: 'compile' | 'decompile',
  result: CompileResult | DecompileResult,
  expected: Expected,
];

const SOURCE_NAME = {
  compile: 'example.bpmnscript',
  decompile: 'example.bpmn',
} as const;

describe('conversion commands: what the author is shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each<Row>([
    [
      'a decompile that dropped something names the file once and the dropped item after it',
      'decompile',
      {
        ok: true,
        output: 'process P { start S end E }',
        warnings: [
          {
            elementId: 'Task1',
            category: 'extensionAttribute',
            message: "The 'formRef' setting on 'Task1' was not imported",
          },
        ],
      },
      {
        info: ['BPMNscript: Decompiled "example.bpmn" -> "example.bpmnscript"'],
        warning: [
          'BPMNscript: "example.bpmn" reported 1 item(s) during decompile: ' +
            "Task1: The 'formRef' setting on 'Task1' was not imported",
        ],
        returns: '/tmp/example.bpmnscript',
      },
    ],
    [
      'two same-worded warnings are told apart by the element each is about',
      'decompile',
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
      },
    ],
    [
      'a refused construct is reported as an error naming the file once, and nothing is written',
      'decompile',
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
      'a validation failure reports the count and publishes the diagnostics to the Problems panel',
      'compile',
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
        published: [
          [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              'bad',
              vscode.DiagnosticSeverity.Error,
            ),
          ],
        ],
      },
    ],
    [
      'an unexpected failure is reported as an error naming the file once',
      'compile',
      { ok: false, kind: 'error', message: 'boom' },
      {
        error: ['BPMNscript: Failed to compile "example.bpmnscript": boom'],
        returns: undefined,
      },
    ],
  ])('%s', async (_title, command, result, expected) => {
    const diagnostics = fakeDiagnosticCollection();
    let handler: (uri?: vscode.Uri) => Promise<vscode.Uri | undefined>;
    if (command === 'compile') {
      vi.mocked(compileDslToBpmn).mockResolvedValue(result as CompileResult);
      handler = compileCommand(diagnostics.collection, '0.0.1');
    } else {
      vi.mocked(decompileBpmnToDsl).mockResolvedValue(
        result as DecompileResult,
      );
      handler = decompileCommand(diagnostics.collection);
    }

    const sourceName = SOURCE_NAME[command];
    const returned = await handler(vscode.Uri.file(`/tmp/${sourceName}`));

    const { info = [], warning = [], error = [] } = expected;
    expect(returned?.fsPath).toBe(expected.returns);
    expect(notifications()).toEqual({ info, warning, error });

    // Stale diagnostics go on every outcome; only the validation branch fills
    // the panel again.
    expect(diagnostics.cleared).toHaveBeenCalledTimes(1);
    expect(
      diagnostics.set.mock.calls.map(([, published]) => published),
    ).toEqual(expected.published ?? []);

    // The file is named once per line. The success line is the exception: it
    // names the file it read and the file it wrote.
    for (const message of [...warning, ...error]) {
      expect(occurrences(message, sourceName)).toBe(1);
    }
  });
});
