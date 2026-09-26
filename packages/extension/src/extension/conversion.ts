import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from './conversion-core.js';

type ConvertHandler = (uri?: vscode.Uri) => Promise<vscode.Uri | undefined>;

interface Source {
  uri: vscode.Uri;
  name: string;
  text: string;
}

// An open TextDocument carries unsaved edits.
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

async function readSource(
  uri: vscode.Uri | undefined,
  ext: '.bpmnscript' | '.bpmn',
  otherCommand: 'Decompile to BPMNscript' | 'Compile to BPMN',
): Promise<Source | undefined> {
  const sourceUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!sourceUri) {
    await vscode.window.showWarningMessage(
      `BPMNscript: No file selected. Open a ${ext} file or select one in the Explorer.`,
    );
    return undefined;
  }
  const name = path.basename(sourceUri.fsPath);
  if (path.extname(sourceUri.fsPath).toLowerCase() !== ext) {
    await vscode.window.showWarningMessage(
      `BPMNscript: "${name}" is not a ${ext} file; use "${otherCommand}" for it.`,
    );
    return undefined;
  }
  return { uri: sourceUri, name, text: await readText(sourceUri) };
}

async function confirmOverwrite(outputUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(outputUri);
  } catch {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `"${outputUri.fsPath}" already exists. Overwrite?`,
    { modal: true },
    'Overwrite',
  );
  return answer === 'Overwrite';
}

async function writeOutput(
  source: Source,
  ext: '.bpmn' | '.bpmnscript',
  verb: 'Compiled' | 'Decompiled',
  output: string,
): Promise<vscode.Uri | undefined> {
  const outputPath = swapExtension(source.uri.fsPath, ext);
  const outputUri = vscode.Uri.file(outputPath);
  if (!(await confirmOverwrite(outputUri))) {
    return undefined;
  }
  await vscode.workspace.fs.writeFile(
    outputUri,
    new TextEncoder().encode(output),
  );
  await vscode.window.showTextDocument(outputUri);
  void vscode.window.showInformationMessage(
    `BPMNscript: ${verb} "${source.name}" -> "${path.basename(outputPath)}"`,
  );
  return outputUri;
}

export function compileCommand(extensionVersion: string): ConvertHandler {
  return async (uri) => {
    const source = await readSource(
      uri,
      '.bpmnscript',
      'Decompile to BPMNscript',
    );
    if (!source) {
      return undefined;
    }

    const result = await compileDslToBpmn(source.text, extensionVersion);
    if (!result.ok) {
      if (result.kind === 'validation') {
        // The language client already publishes these diagnostics.
        await vscode.window.showTextDocument(source.uri);
        await vscode.commands.executeCommand('workbench.action.problems.focus');
        await vscode.window.showErrorMessage(
          `BPMNscript: "${source.name}" has ${result.diagnostics.length} compilation error(s). See the Problems panel.`,
        );
      } else {
        await vscode.window.showErrorMessage(
          `BPMNscript: Failed to compile "${source.name}": ${result.message}`,
        );
      }
      return undefined;
    }

    const outputUri = await writeOutput(
      source,
      '.bpmn',
      'Compiled',
      result.output,
    );
    if (outputUri && result.layoutWarning) {
      void vscode.window.showWarningMessage(
        `BPMNscript: "${source.name}" compiled without a diagram: ${result.layoutWarning}`,
      );
    }
    return outputUri;
  };
}

export function decompileCommand(): ConvertHandler {
  return async (uri) => {
    const source = await readSource(uri, '.bpmn', 'Compile to BPMN');
    if (!source) {
      return undefined;
    }

    const result = await decompileBpmnToDsl(source.text);
    if (!result.ok) {
      await vscode.window.showErrorMessage(
        result.kind === 'unsupported'
          ? `BPMNscript: "${source.name}" contains an unsupported construct: ${result.message}`
          : `BPMNscript: Failed to decompile "${source.name}": ${result.message}`,
      );
      return undefined;
    }

    const outputUri = await writeOutput(
      source,
      '.bpmnscript',
      'Decompiled',
      result.output,
    );
    if (outputUri && result.warnings.length > 0) {
      // Several messages do not name their step, so the id tells them apart.
      const details = result.warnings
        .map((w) => `${w.elementId}: ${w.message}`)
        .join('; ');
      void vscode.window.showWarningMessage(
        `BPMNscript: "${source.name}" reported ${result.warnings.length} item(s) during decompile: ${details}`,
      );
    }
    return outputUri;
  };
}

export function pickBpmnAndDecompileCommand(
  decompile: ConvertHandler,
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
