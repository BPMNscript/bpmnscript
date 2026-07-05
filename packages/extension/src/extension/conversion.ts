/**
 * VS Code adapter for the BPMNscript conversion core.
 *
 * Resolves source URIs, reads text (preferring unsaved in-memory documents),
 * calls the pure core functions, surfaces results via VS Code notifications
 * and the Problems panel, and writes output files next to the source.
 *
 * No conversion logic lives here — only the VS Code I/O layer around the core.
 * Correctness of the conversion pipeline is covered by `conversion-core` tests
 * and the bundled-conversion E2E suite.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from './conversion-core.js';
import type { ConvDiagnostic } from './conversion-core.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the source Uri for a command invocation.
 *
 * Preference order:
 *  1. The `uri` argument (passed by editor-title / explorer-context / sidebar).
 *  2. The active text editor's document URI (command palette).
 */
function resolveSourceUri(uri?: vscode.Uri): vscode.Uri | undefined {
  return uri ?? vscode.window.activeTextEditor?.document.uri;
}

/**
 * Read the text of a VS Code resource.
 *
 * Prefers an open `TextDocument` so that unsaved (dirty) document contents
 * are used rather than the on-disk version.
 */
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

/**
 * Confirm an overwrite when the target path already exists.
 *
 * Returns `true` when the user confirms, `false` when they cancel or dismiss.
 * Returns `true` immediately when the target does not exist.
 */
async function confirmOverwrite(outputUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(outputUri);
  } catch {
    // Stat threw — file does not exist; no confirmation needed.
    return true;
  }
  // File exists — ask.
  const answer = await vscode.window.showWarningMessage(
    `"${outputUri.fsPath}" already exists. Overwrite?`,
    { modal: true },
    'Overwrite',
  );
  return answer === 'Overwrite';
}

/**
 * Map a `ConvDiagnostic` from the core to a `vscode.Diagnostic`.
 */
function toVsDiagnostic(d: ConvDiagnostic): vscode.Diagnostic {
  return new vscode.Diagnostic(
    new vscode.Range(d.line, d.character, d.endLine, d.endCharacter),
    d.message,
    d.severity === 1
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  );
}

// ---------------------------------------------------------------------------
// Exported command factories
// ---------------------------------------------------------------------------

/**
 * Returns the command handler for `bpmnscript.compile`.
 *
 * Resolves the source Uri from the command argument or the active editor,
 * reads the .bpmnscript text, calls `compileDslToBpmn`, and on success
 * writes the BPMN XML next to the source file and opens it.
 *
 * On validation errors: sets diagnostics on the Problems panel and shows an
 * error notification. Does NOT write any output.
 *
 * On unexpected errors: shows an error notification. Does NOT write output.
 *
 * @param diagnostics      DiagnosticCollection owned by the extension host.
 * @param extensionVersion Stamped into the generated BPMN `exporterVersion`.
 * @returns A command handler that returns the output `Uri` on success so
 *   callers (e.g. the sidebar provider) can react to the produced file.
 */
export function compileCommand(
  diagnostics: vscode.DiagnosticCollection,
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
    const text = await readText(sourceUri);

    const result = await compileDslToBpmn(
      text,
      sourceFileName,
      extensionVersion,
    );

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

      // Clear any previous compilation diagnostics for this source file.
      diagnostics.delete(sourceUri);

      await vscode.window.showTextDocument(outputUri);

      void vscode.window.showInformationMessage(
        `BPMNscript: Compiled "${sourceFileName}" → "${path.basename(outputPath)}"`,
      );

      return outputUri;
    } else if (result.kind === 'validation') {
      diagnostics.set(sourceUri, result.diagnostics.map(toVsDiagnostic));
      await vscode.window.showErrorMessage(
        `BPMNscript: "${sourceFileName}" has ${result.diagnostics.length} compilation error(s). See the Problems panel.`,
      );
      return undefined;
    } else {
      // kind:'error' — unexpected runtime failure.
      await vscode.window.showErrorMessage(
        `BPMNscript: Failed to compile "${sourceFileName}": ${result.message}`,
      );
      return undefined;
    }
  };
}

/**
 * Returns the command handler for `bpmnscript.decompile`.
 *
 * Resolves the source Uri from the command argument or the active editor,
 * reads the .bpmn XML, calls `decompileBpmnToDsl`, and on success writes
 * the BPMNscript DSL next to the source file and opens it.
 *
 * On unsupported-construct errors: shows an error notification that includes
 * the source file name. The core returns a context-free message; the adapter
 * prepends the filename here exactly once. Does NOT write any output.
 *
 * On success with non-empty `warnings` (non-semantic content the transform
 * dropped, e.g. extra Operaton/camunda extension attributes or lanes): shows
 * one aggregated warning notification, filename-prefixed exactly once, so the
 * drop is never silent. This does not block the write.
 *
 * On unexpected errors: shows an error notification. Does NOT write output.
 *
 * @param diagnostics DiagnosticCollection (cleared on success).
 * @returns A command handler that returns the output `Uri` on success so
 *   callers (e.g. the sidebar provider) can react to the produced file.
 */
export function decompileCommand(
  diagnostics: vscode.DiagnosticCollection,
): (uri?: vscode.Uri) => Promise<vscode.Uri | undefined> {
  return async (uri?: vscode.Uri): Promise<vscode.Uri | undefined> => {
    const sourceUri = resolveSourceUri(uri);
    if (!sourceUri) {
      await vscode.window.showWarningMessage(
        'BPMNscript: No file selected. Open a .bpmn file or select one in the Explorer.',
      );
      return undefined;
    }

    const sourceFileName = path.basename(sourceUri.fsPath);
    const text = await readText(sourceUri);

    const result = await decompileBpmnToDsl(text, sourceFileName);

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

      // Clear any diagnostics associated with this source file.
      diagnostics.delete(sourceUri);

      await vscode.window.showTextDocument(outputUri);

      void vscode.window.showInformationMessage(
        `BPMNscript: Decompiled "${sourceFileName}" → "${path.basename(outputPath)}"`,
      );

      // Non-semantic drops (extra Operaton/camunda extension attributes,
      // lanes) never got an IR representation and would otherwise vanish
      // silently. Surface them as one aggregated warning, filename-prefixed
      // exactly once — symmetric with the unsupported-construct message below.
      if (result.warnings.length > 0) {
        const details = result.warnings
          .map((w) => `${w.elementId}: ${w.message}`)
          .join('; ');
        void vscode.window.showWarningMessage(
          `BPMNscript: "${sourceFileName}" dropped ${result.warnings.length} item(s) during decompile: ${details}`,
        );
      }

      return outputUri;
    } else if (result.kind === 'unsupported') {
      // The core returns a context-free message; prepend the filename once here.
      await vscode.window.showErrorMessage(
        `BPMNscript: "${sourceFileName}" contains an unsupported construct: ${result.message}`,
      );
      return undefined;
    } else {
      // kind:'error' — unexpected runtime failure.
      await vscode.window.showErrorMessage(
        `BPMNscript: Failed to decompile "${sourceFileName}": ${result.message}`,
      );
      return undefined;
    }
  };
}

/**
 * Returns the command handler for `bpmnscript.openAndDecompile`.
 *
 * Opens a file picker for a `.bpmn` file, then runs the decompile handler on
 * the chosen file (which writes the `.bpmnscript` next to it and opens it).
 * Does nothing if the user dismisses the picker.
 *
 * @param decompile The `bpmnscript.decompile` handler to run on the picked file.
 */
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
