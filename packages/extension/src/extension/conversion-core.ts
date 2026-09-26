// No `vscode` import, so unit tests run this without an editor host.

import {
  createBpmnScriptServices,
  Diagnostic,
  DiagnosticSeverity,
} from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { EmptyFileSystem, URI } from 'langium';
import * as path from 'node:path';
import {
  astToIr,
  irToXml,
  xmlToIr,
  irToDsl,
  NO_PROCESS_MESSAGE,
  readableParseError,
  xmlInputProblem,
  UnsupportedConstructError,
  LayoutError,
} from '@bpmn-script/transform';
import type { ImportWarning, PrintWarning } from '@bpmn-script/transform';

export interface ConvDiagnostic {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  message: string;
  severity: 1 | 2;
  text: string;
}

export type CompileResult =
  | { ok: true; output: string; layoutWarning?: string }
  | { ok: false; kind: 'validation'; diagnostics: ConvDiagnostic[] }
  | { ok: false; kind: 'error'; message: string };

export type DecompileResult =
  | { ok: true; output: string; warnings: (ImportWarning | PrintWarning)[] }
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };

const { shared } = createBpmnScriptServices(EmptyFileSystem);

let nextDocId = 0;

export async function compileDslToBpmn(
  source: string,
  exporterVersion: string,
): Promise<CompileResult> {
  const uri = URI.parse(`memory:///conv-${nextDocId++}.bpmnscript`);

  // Registered so cross-references resolve, removed so the index does not grow.
  const doc = shared.workspace.LangiumDocumentFactory.fromString<Model>(
    source,
    uri,
  );
  shared.workspace.LangiumDocuments.addDocument(doc);

  try {
    await shared.workspace.DocumentBuilder.build([doc], { validation: true });

    const errors = (doc.diagnostics ?? []).filter(
      (d) => d.severity === DiagnosticSeverity.Error,
    );
    if (errors.length > 0) {
      const diagnostics: ConvDiagnostic[] = errors.map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        message: Diagnostic.getMessageString(d),
        severity: DiagnosticSeverity.Error,
        text: doc.textDocument.getText(d.range),
      }));
      return { ok: false, kind: 'validation', diagnostics };
    }

    // After the error gate: a keyword typo also parses into a model with no processes.
    if (doc.parseResult.value.processes.length === 0) {
      return { ok: false, kind: 'error', message: NO_PROCESS_MESSAGE };
    }

    let ir;
    try {
      ir = astToIr(doc.parseResult.value);
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        message: `AST to IR conversion failed: ${(err as Error).message}`,
      };
    }

    let output;
    let layoutWarning: string | undefined;
    try {
      output = await irToXml(ir, { exporterVersion });
    } catch (err) {
      if (err instanceof LayoutError) {
        output = err.xml;
        layoutWarning = err.message;
      } else {
        return {
          ok: false,
          kind: 'error',
          message: `IR to XML conversion failed: ${(err as Error).message}`,
        };
      }
    }

    return {
      ok: true,
      output,
      ...(layoutWarning !== undefined ? { layoutWarning } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      message: (err as Error).message,
    };
  } finally {
    shared.workspace.LangiumDocuments.deleteDocument(uri);
  }
}

export async function decompileBpmnToDsl(
  xml: string,
): Promise<DecompileResult> {
  const problem = xmlInputProblem(xml);
  if (problem !== undefined) {
    return { ok: false, kind: 'error', message: problem };
  }

  let ir;
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    if (err instanceof UnsupportedConstructError) {
      return { ok: false, kind: 'unsupported', message: err.message };
    }
    // A parser error quotes the rest of the document, too long for a notification.
    return {
      ok: false,
      kind: 'error',
      message: readableParseError((err as Error).message, xml),
    };
  }

  let output: string;
  let printWarnings: PrintWarning[];
  try {
    ({ source: output, warnings: printWarnings } = irToDsl(ir));
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      message: `IR to DSL conversion failed: ${(err as Error).message}`,
    };
  }

  return { ok: true, output, warnings: [...warnings, ...printWarnings] };
}

// Importing the cli's `resolveOutputPath` would pull chalk and commander into the bundle.
export function swapExtension(filePath: string, newExt: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}${newExt}`);
}
