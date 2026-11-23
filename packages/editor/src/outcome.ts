import type { CompileResult, DecompileResult } from './protocol';

export type Message = { headline: string; notes: string[] };

export type CompileView = {
  state: 'ok' | 'error';
  xml?: string;
  errors: number;
  /** 1-based */
  firstErrorLine?: number;
  layoutWarning?: string;
  message?: string;
};

export type ImportView = {
  kind: 'ok' | 'warning' | 'refused';
  source?: string;
  warnings: Message[];
  message?: Message;
};

/** What a compile result means for the editor: an XML to show, or how many errors and where the first is. */
export function compileView(r: CompileResult): CompileView {
  if (r.ok)
    return {
      state: 'ok',
      xml: r.output,
      errors: 0,
      layoutWarning: r.layoutWarning,
    };
  if (r.kind === 'error')
    return { state: 'error', errors: 1, message: r.message };
  // Warnings (severity 2) do not block a compile; only errors count.
  const errs = r.diagnostics.filter((d) => d.severity === 1);
  return {
    state: 'error',
    errors: errs.length,
    firstErrorLine: errs.length
      ? Math.min(...errs.map((d) => d.line)) + 1
      : undefined,
  };
}

/** First line is the headline; the rest are notes, kept verbatim (prefixes included). */
function splitMessage(text: string): Message {
  const [headline = '', ...rest] = text.split('\n');
  const notes = rest.map((l) => l.trim()).filter(Boolean);
  return { headline, notes };
}

/** What an import result means: the source to open, its warnings, or why the import was refused. */
export function importView(r: DecompileResult): ImportView {
  if (!r.ok)
    return { kind: 'refused', warnings: [], message: splitMessage(r.message) };
  const warnings = r.warnings.map((w) => splitMessage(w.message));
  return {
    kind: warnings.length ? 'warning' : 'ok',
    source: r.output,
    warnings,
  };
}

/** A file name for an export, from the process id in BPMN XML or BPMNscript source. */
export function exportName(
  xmlOrSource: string,
  ext: '.bpmn' | '.bpmnscript',
): string {
  const m =
    /<bpmn:process\b[^>]*\bid="([^"]*)"/.exec(xmlOrSource) ??
    /^\s*process\s+([^\s({]+)/m.exec(xmlOrSource);
  const name = (m?.[1] ?? '').replace(/[^\w-]/g, '_');
  return (name || 'process') + ext;
}
