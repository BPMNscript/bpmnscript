// No `vscode` import here: the unit tests run this without an editor host.
// `conversion.ts` is the VS Code adapter.

import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { EmptyFileSystem, URI } from 'langium';
import * as path from 'node:path';
import {
  astToIr,
  irToXml,
  xmlToIr,
  irToDsl,
  UnsupportedConstructError,
} from '@bpmn-script/transform';
import type { ImportWarning } from '@bpmn-script/transform';

// Positions are 0-based, LSP convention.
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
  | { ok: true; output: string }
  | { ok: false; kind: 'validation'; diagnostics: ConvDiagnostic[] }
  | { ok: false; kind: 'error'; message: string };

export type DecompileResult =
  | { ok: true; output: string; warnings: ImportWarning[] }
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };

const SEVERITY_ERROR = 1;

// Built once per module load: creating the services is expensive.
const { shared } = createBpmnScriptServices(EmptyFileSystem);

let nextDocId = 0;

export async function compileDslToBpmn(
  source: string,
  sourceFileName: string,
  exporterVersion: string,
): Promise<CompileResult> {
  const uri = URI.parse(`memory:///conv-${nextDocId++}.bpmnscript`);

  // Registered so the DocumentBuilder can resolve cross-references, and
  // removed afterwards so the index does not grow with every call.
  const doc = shared.workspace.LangiumDocumentFactory.fromString<Model>(
    source,
    uri,
  );
  shared.workspace.LangiumDocuments.addDocument(doc);

  try {
    await shared.workspace.DocumentBuilder.build([doc], { validation: true });

    const errors = (doc.diagnostics ?? []).filter(
      (d) => d.severity === SEVERITY_ERROR,
    );
    if (errors.length > 0) {
      const diagnostics: ConvDiagnostic[] = errors.map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        message: typeof d.message === 'string' ? d.message : d.message.value,
        severity: SEVERITY_ERROR,
        text: doc.textDocument.getText(d.range),
      }));
      return { ok: false, kind: 'validation', diagnostics };
    }

    const ast = doc.parseResult.value as Model;
    let ir;
    try {
      ir = astToIr(ast);
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        message: `AST to IR conversion failed: ${(err as Error).message}`,
      };
    }

    let output;
    try {
      output = await irToXml(ir, { sourceFileName, exporterVersion });
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        message: `IR to XML conversion failed: ${(err as Error).message}`,
      };
    }

    return { ok: true, output };
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
  _sourceFileName: string, // unused; keeps the signature parallel to compile
): Promise<DecompileResult> {
  let ir;
  let warnings: ImportWarning[];
  try {
    ({ ir, warnings } = await xmlToIr(xml));
  } catch (err) {
    if (err instanceof UnsupportedConstructError) {
      return { ok: false, kind: 'unsupported', message: err.message };
    }
    return {
      ok: false,
      kind: 'error',
      message: (err as Error).message,
    };
  }

  let output;
  try {
    output = irToDsl(ir);
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      message: `IR to DSL conversion failed: ${(err as Error).message}`,
    };
  }

  return { ok: true, output, warnings };
}

// Duplicated from `packages/cli/src/util.ts` rather than imported: importing it
// would pull chalk and commander into the extension bundle.
export function swapExtension(filePath: string, newExt: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}${newExt}`);
}
