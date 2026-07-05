/**
 * Unit tests for the VS Code adapter layer in `conversion.ts`.
 *
 * `vscode` is not an installed npm package — it is injected by the VS Code
 * extension host at runtime — so it is mocked here with the minimal surface
 * the adapter touches. `conversion-core.ts` is mocked too, so each test
 * drives a canned `CompileResult`/`DecompileResult` and asserts only on the
 * composed notification string the adapter builds around it: the
 * single-filename-prefix contract documented on `compileCommand` and
 * `decompileCommand`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the rest of the module, so the mock
// functions referenced inside must be created through `vi.hoisted` — a plain
// top-level `const` would still be in its temporal dead zone when the
// factory below runs.
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
        // Rejects so `confirmOverwrite` takes the "target does not exist,
        // no confirmation needed" branch in every test below.
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
import {
  compileCommand,
  decompileCommand,
} from '../src/extension/conversion.js';

/** A `DiagnosticCollection` stub — only `set`/`delete` are ever called. */
function fakeDiagnosticCollection(): vscode.DiagnosticCollection {
  return {
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as vscode.DiagnosticCollection;
}

/** Count of occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('decompileCommand — composed notification strings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefixes the filename exactly once in the aggregated drop-warning message', async () => {
    vi.mocked(decompileBpmnToDsl).mockResolvedValue({
      ok: true,
      output: 'process P { start S end E }',
      warnings: [
        {
          elementId: 'Task1',
          category: 'extensionAttribute',
          message: 'dropped assignee',
        },
      ],
    });

    const handler = decompileCommand(fakeDiagnosticCollection());
    await handler(vscode.Uri.file('/tmp/example.bpmn'));

    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    const message = mocks.showWarningMessage.mock.calls[0]?.[0] as string;
    expect(message).toBe(
      'BPMNscript: "example.bpmn" dropped 1 item(s) during decompile: ' +
        'Task1: dropped assignee',
    );
    expect(occurrences(message, 'example.bpmn')).toBe(1);
  });

  it('prefixes the filename exactly once in the unsupported-construct error message', async () => {
    vi.mocked(decompileBpmnToDsl).mockResolvedValue({
      ok: false,
      kind: 'unsupported',
      message: 'multiple linked processes (pools and message flows).',
    });

    const handler = decompileCommand(fakeDiagnosticCollection());
    await handler(vscode.Uri.file('/tmp/example.bpmn'));

    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = mocks.showErrorMessage.mock.calls[0]?.[0] as string;
    expect(message).toBe(
      'BPMNscript: "example.bpmn" contains an unsupported construct: ' +
        'multiple linked processes (pools and message flows).',
    );
    expect(occurrences(message, 'example.bpmn')).toBe(1);
  });
});

describe('compileCommand — composed notification strings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the diagnostic count in the validation-error message', async () => {
    vi.mocked(compileDslToBpmn).mockResolvedValue({
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
    });

    const handler = compileCommand(fakeDiagnosticCollection(), '0.0.1');
    await handler(vscode.Uri.file('/tmp/example.bpmnscript'));

    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'BPMNscript: "example.bpmnscript" has 1 compilation error(s). See the Problems panel.',
    );
  });

  it('prefixes the filename exactly once in the unexpected-error message', async () => {
    vi.mocked(compileDslToBpmn).mockResolvedValue({
      ok: false,
      kind: 'error',
      message: 'boom',
    });

    const handler = compileCommand(fakeDiagnosticCollection(), '0.0.1');
    await handler(vscode.Uri.file('/tmp/example.bpmnscript'));

    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = mocks.showErrorMessage.mock.calls[0]?.[0] as string;
    expect(message).toBe(
      'BPMNscript: Failed to compile "example.bpmnscript": boom',
    );
    expect(occurrences(message, 'example.bpmnscript')).toBe(1);
  });
});
