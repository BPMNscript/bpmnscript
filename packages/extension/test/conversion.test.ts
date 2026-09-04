// `vscode` is injected by the extension host, not installed from npm, so it
// has to be mocked with the surface the adapter touches.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        // branch, so no test below hits the modal.
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

function fakeDiagnosticCollection(): vscode.DiagnosticCollection {
  return {
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as vscode.DiagnosticCollection;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('decompileCommand: composed notification strings', () => {
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
          message: "The 'formRef' setting on 'Task1' was not imported",
        },
      ],
    });

    const handler = decompileCommand(fakeDiagnosticCollection());
    await handler(vscode.Uri.file('/tmp/example.bpmn'));

    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    const message = mocks.showWarningMessage.mock.calls[0]?.[0] as string;
    expect(message).toBe(
      'BPMNscript: "example.bpmn" dropped 1 item(s) during decompile: ' +
        "The 'formRef' setting on 'Task1' was not imported",
    );
    expect(occurrences(message, 'example.bpmn')).toBe(1);
    // The core message is the only source of the element id; the adapter must
    // not prepend its own copy.
    expect(occurrences(message, 'Task1')).toBe(1);
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

describe('compileCommand: composed notification strings', () => {
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

    const diagnostics = fakeDiagnosticCollection();
    const handler = compileCommand(diagnostics, '0.0.1');
    await handler(vscode.Uri.file('/tmp/example.bpmnscript'));

    expect(diagnostics.delete).toHaveBeenCalledTimes(1);
    expect(diagnostics.set).toHaveBeenCalledTimes(1);

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

    const diagnostics = fakeDiagnosticCollection();
    const handler = compileCommand(diagnostics, '0.0.1');
    await handler(vscode.Uri.file('/tmp/example.bpmnscript'));

    // Stale diagnostics go even on the unexpected-failure path.
    expect(diagnostics.delete).toHaveBeenCalledTimes(1);

    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = mocks.showErrorMessage.mock.calls[0]?.[0] as string;
    expect(message).toBe(
      'BPMNscript: Failed to compile "example.bpmnscript": boom',
    );
    expect(occurrences(message, 'example.bpmnscript')).toBe(1);
  });
});
