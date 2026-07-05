/**
 * Pure conversion core — no `vscode` import, fully unit-testable under vitest.
 *
 * Provides `compileDslToBpmn` (DSL → BPMN XML) and `decompileBpmnToDsl`
 * (BPMN XML → DSL) as typed, host-free functions that return discriminated
 * result unions instead of throwing or calling `process.exit`.
 *
 * The VS Code adapter (`conversion.ts`) is a thin wrapper that calls these
 * functions and maps their results to VS Code notifications, diagnostics, and
 * file system writes.
 */

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

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** A single diagnostic produced by the Langium validation pass. */
export interface ConvDiagnostic {
  /** 0-based start line (LSP convention). */
  line: number;
  /** 0-based start character. */
  character: number;
  /** 0-based end line. */
  endLine: number;
  /** 0-based end character. */
  endCharacter: number;
  /** Human-readable diagnostic message. */
  message: string;
  /** LSP severity: `1` = Error, `2` = Warning. Only errors are ever returned here. */
  severity: 1 | 2;
  /** The source text spanned by the diagnostic range. */
  text: string;
}

/**
 * Result of a DSL → BPMN XML compile operation.
 *
 * - `ok:true`  → `output` is the BPMN 2.0 XML string.
 * - `ok:false, kind:'validation'` → Langium reported one or more severity-1
 *   errors; `diagnostics` lists each one.
 * - `ok:false, kind:'error'` → an unexpected runtime error occurred.
 */
export type CompileResult =
  | { ok: true; output: string }
  | { ok: false; kind: 'validation'; diagnostics: ConvDiagnostic[] }
  | { ok: false; kind: 'error'; message: string };

/**
 * Result of a BPMN XML → DSL decompile operation.
 *
 * - `ok:true`  → `output` is the BPMNscript DSL string; `warnings` lists any
 *   non-semantic content the transform dropped (extra Operaton/camunda
 *   extension attributes, lanes). Empty for input that round-trips cleanly.
 * - `ok:false, kind:'unsupported'` → the BPMN contains a construct that the
 *   transform cannot represent in the IR at all (see
 *   `UnsupportedConstructError` and its subclasses in `@bpmn-script/transform`).
 * - `ok:false, kind:'error'` → an unexpected runtime error occurred.
 */
export type DecompileResult =
  | { ok: true; output: string; warnings: ImportWarning[] }
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Module-level Langium services (created once — expensive to build)
// ---------------------------------------------------------------------------

const { shared } = createBpmnScriptServices(EmptyFileSystem);

// Counter for unique in-memory document URIs across calls.
let nextDocId = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a BPMNscript DSL string to BPMN 2.0 XML.
 *
 * Mirrors the pipeline in `packages/cli/src/build.ts` but returns a typed
 * result instead of writing to disk or calling `process.exit`.
 *
 * Severity gating: only Langium diagnostics with severity 1 (Error) block
 * compilation. Severity 2 (Warning) diagnostics — e.g. undeclared-variable
 * warnings — do not prevent a successful output.
 *
 * @param source         BPMNscript source text.
 * @param sourceFileName Base name used in the generated BPMN `exporter` attribute.
 * @param exporterVersion Version string stamped into the generated BPMN.
 */
export async function compileDslToBpmn(
  source: string,
  sourceFileName: string,
  exporterVersion: string,
): Promise<CompileResult> {
  const uri = URI.parse(`memory:///conv-${nextDocId++}.bpmnscript`);

  // Create a fresh in-memory document; register it so the DocumentBuilder can
  // resolve cross-references; remove it afterwards to avoid index buildup.
  const doc = shared.workspace.LangiumDocumentFactory.fromString<Model>(
    source,
    uri,
  );
  shared.workspace.LangiumDocuments.addDocument(doc);

  try {
    await shared.workspace.DocumentBuilder.build([doc], { validation: true });

    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    if (errors.length > 0) {
      const diagnostics: ConvDiagnostic[] = errors.map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        message: typeof d.message === 'string' ? d.message : d.message.value,
        severity: 1 as const,
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

/**
 * Decompile a BPMN 2.0 XML string to a BPMNscript DSL string.
 *
 * Mirrors the pipeline in `packages/cli/src/parse.ts` but returns a typed
 * result instead of writing to disk or calling `process.exit`.
 *
 * Every `UnsupportedConstructError` subclass (unsupported service task form,
 * unsupported element kind, event definitions, loop characteristics,
 * collaborations) is classified as `kind:'unsupported'` via a single
 * base-class check.
 *
 * @param xml BPMN 2.0 XML string.
 */
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
      // Every refusal subclass's own message already names the offending
      // construct and element concretely — surface it verbatim.
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

/**
 * Strip the final extension from `filePath` and append `newExt`.
 *
 * Mirrors the default-branch logic of `packages/cli/src/util.ts`
 * `resolveOutputPath` — dotted basenames (e.g. `my.invoice.bpmnscript`) keep
 * everything before the final extension.
 *
 * Not imported from the CLI package to avoid pulling its app-level
 * dependencies (chalk, commander) into the extension bundle.
 *
 * @param filePath Absolute or relative file path.
 * @param newExt   New extension, including the leading dot (e.g. `'.bpmn'`).
 */
export function swapExtension(filePath: string, newExt: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}${newExt}`);
}
