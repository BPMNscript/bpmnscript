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
 *
 * Build-order note: this module imports `@bpmn-script/language` and
 * `@bpmn-script/transform` via their compiled `out/` directories. Rebuild
 * those packages before running extension tests or building the extension —
 * a source edit in either package is invisible until rebuilt.
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
  UnsupportedServiceTaskFormError,
  UnsupportedElementError,
} from '@bpmn-script/transform';

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
 * - `ok:true`  → `output` is the BPMNscript DSL string.
 * - `ok:false, kind:'unsupported'` → the BPMN contains a construct that the
 *   transform cannot represent in the IR or DSL.
 * - `ok:false, kind:'error'` → an unexpected runtime error occurred.
 */
export type DecompileResult =
  | { ok: true; output: string }
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

    // Filter to severity 1 (Error) only — warnings do not block.
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    if (errors.length > 0) {
      const diagnostics: ConvDiagnostic[] = errors.map((d) => ({
        line: d.range.start.line,
        character: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
        message: d.message,
        severity: 1 as const,
        text: doc.textDocument.getText(d.range),
      }));
      return { ok: false, kind: 'validation', diagnostics };
    }

    // No blocking errors — proceed through the pipeline.
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
 * `UnsupportedServiceTaskFormError` and `UnsupportedElementError` are mapped
 * to `kind:'unsupported'` so callers can surface a loud, actionable message
 * rather than silently emitting an incomplete DSL.
 *
 * Returned error messages are context-free (no filename prefix). The VS Code
 * adapter (`conversion.ts`) owns presentation and prepends the filename
 * exactly once when composing user-facing notifications — symmetric with
 * `compileDslToBpmn`.
 *
 * @param xml              BPMN 2.0 XML string.
 * @param _sourceFileName  Accepted for call-site symmetry with `compileDslToBpmn`;
 *                         not used here — the adapter adds file context to messages.
 */
export async function decompileBpmnToDsl(
  xml: string,
  _sourceFileName: string,
): Promise<DecompileResult> {
  let ir;
  try {
    ir = await xmlToIr(xml);
  } catch (err) {
    if (err instanceof UnsupportedServiceTaskFormError) {
      // Use the error's own message — it names both the service task id and
      // the offending execution discriminator (e.g. "operaton:expression").
      return { ok: false, kind: 'unsupported', message: err.message };
    }
    if (err instanceof UnsupportedElementError) {
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

  return { ok: true, output };
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
