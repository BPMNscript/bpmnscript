import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from './conversion-core.js';

function resolveSourceUri(uri?: vscode.Uri): vscode.Uri | undefined {
  return uri ?? vscode.window.activeTextEditor?.document.uri;
}

// Prefers an open TextDocument so unsaved edits convert, not the stale file.
async function readText(sourceUri: vscode.Uri): Promise<string> {
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === sourceUri.toString(),
  );
  if (openDoc) {
    return openDoc.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(sourceUri);
  return new TextDecoder().decode(bytes);
}

async function confirmOverwrite(outputUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(outputUri);
  } catch {
    // stat throws when the target does not exist: nothing to overwrite.
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `"${outputUri.fsPath}" already exists. Overwrite?`,
    { modal: true },
    'Overwrite',
  );
  return answer === 'Overwrite';
}

export function compileCommand(
  extensionVersion: string,
): (uri?: vscode.Uri) => Promise<vscode.Uri | undefined> {
  return async (uri?: vscode.Uri): Promise<vscode.Uri | undefined> => {
    const sourceUri = resolveSourceUri(uri);
    if (!sourceUri) {
      await vscode.window.showWarningMessage(
        'BPMNscript: No file selected. Open a .bpmnscript file or select one in the Explorer.',
      );
      return undefined;
    }

    const sourceFileName = path.basename(sourceUri.fsPath);

    if (path.extname(sourceUri.fsPath).toLowerCase() !== '.bpmnscript') {
      await vscode.window.showWarningMessage(
        `BPMNscript: "${sourceFileName}" is not a .bpmnscript file; ` +
          'use "Decompile to BPMNscript" for it.',
      );
      return undefined;
    }

    const text = await readText(sourceUri);

    const result = await compileDslToBpmn(text, extensionVersion);

    if (result.ok) {
      const outputPath = swapExtension(sourceUri.fsPath, '.bpmn');
      const outputUri = vscode.Uri.file(outputPath);

      if (!(await confirmOverwrite(outputUri))) {
        return undefined;
      }

      await vscode.workspace.fs.writeFile(
        outputUri,
        new TextEncoder().encode(result.output),
      );

      await vscode.window.showTextDocument(outputUri);

      void vscode.window.showInformationMessage(
        `BPMNscript: Compiled "${sourceFileName}" -> "${path.basename(outputPath)}"`,
      );

      if (result.layoutWarning) {
        void vscode.window.showWarningMessage(
          `BPMNscript: "${sourceFileName}" compiled without a diagram: ${result.layoutWarning}`,
        );
      }

      return outputUri;
    } else if (result.kind === 'validation') {
      // The language client already publishes these same diagnostics for
      // every workspace .bpmnscript file; showing the source and focusing
      // Problems is enough, a second collection would only duplicate them.
      await vscode.window.showTextDocument(sourceUri);
      await vscode.commands.executeCommand('workbench.action.problems.focus');
      await vscode.window.showErrorMessage(
        `BPMNscript: "${sourceFileName}" has ${result.diagnostics.length} compilation error(s). See the Problems panel.`,
      );
      return undefined;
    } else {
      await vscode.window.showErrorMessage(
        `BPMNscript: Failed to compile "${sourceFileName}": ${result.message}`,
      );
      return undefined;
    }
  };
}

export function decompileCommand(): (
  uri?: vscode.Uri,
) => Promise<vscode.Uri | undefined> {
  return async (uri?: vscode.Uri): Promise<vscode.Uri | undefined> => {
    const sourceUri = resolveSourceUri(uri);
    if (!sourceUri) {
      await vscode.window.showWarningMessage(
        'BPMNscript: No file selected. Open a .bpmn file or select one in the Explorer.',
      );
      return undefined;
    }

    const sourceFileName = path.basename(sourceUri.fsPath);

    if (path.extname(sourceUri.fsPath).toLowerCase() !== '.bpmn') {
      await vscode.window.showWarningMessage(
        `BPMNscript: "${sourceFileName}" is not a .bpmn file; ` +
          'use "Compile to BPMN" for it.',
      );
      return undefined;
    }

    const text = await readText(sourceUri);

    const result = await decompileBpmnToDsl(text);

    if (result.ok) {
      const outputPath = swapExtension(sourceUri.fsPath, '.bpmnscript');
      const outputUri = vscode.Uri.file(outputPath);

      if (!(await confirmOverwrite(outputUri))) {
        return undefined;
      }

      await vscode.workspace.fs.writeFile(
        outputUri,
        new TextEncoder().encode(result.output),
      );

      await vscode.window.showTextDocument(outputUri);

      void vscode.window.showInformationMessage(
        `BPMNscript: Decompiled "${sourceFileName}" -> "${path.basename(outputPath)}"`,
      );

      if (result.warnings.length > 0) {
        // Each entry leads with its element id, as `bpmns parse` does: several
        // messages describe the route on from a step without naming it, and
        // two of those read as one line repeated when the id is left off.
        const details = result.warnings
          .map((w) => `${w.elementId}: ${w.message}`)
          .join('; ');
        void vscode.window.showWarningMessage(
          `BPMNscript: "${sourceFileName}" reported ${result.warnings.length} item(s) during decompile: ${details}`,
        );
      }

      return outputUri;
    } else if (result.kind === 'unsupported') {
      await vscode.window.showErrorMessage(
        `BPMNscript: "${sourceFileName}" contains an unsupported construct: ${result.message}`,
      );
      return undefined;
    } else {
      await vscode.window.showErrorMessage(
        `BPMNscript: Failed to decompile "${sourceFileName}": ${result.message}`,
      );
      return undefined;
    }
  };
}

export function pickBpmnAndDecompileCommand(
  decompile: (uri?: vscode.Uri) => Promise<vscode.Uri | undefined>,
): () => Promise<void> {
  return async (): Promise<void> => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Convert to BPMNscript',
      title: 'Select a BPMN file to convert to BPMNscript',
      filters: { 'BPMN 2.0': ['bpmn'], 'All files': ['*'] },
    });
    if (!picked || picked.length === 0) {
      return;
    }
    await decompile(picked[0]);
  };
}
