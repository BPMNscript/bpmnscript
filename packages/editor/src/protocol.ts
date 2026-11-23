/** Wire types of the BPMNscript worker (`@bpmn-script/web`); mirrors its results without importing them. */
export const COMPILE_METHOD = 'bpmnscript/compile';
export const DECOMPILE_METHOD = 'bpmnscript/decompile';

/** 0-based positions, as produced by the compiler. */
export type ConvDiagnostic = {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  message: string;
  severity: 1 | 2;
  text: string;
};

export type ImportWarning = {
  elementId: string;
  category: string;
  message: string;
};

export type CompileResult =
  | { ok: true; output: string; layoutWarning?: string }
  | { ok: false; kind: 'validation'; diagnostics: ConvDiagnostic[] }
  | { ok: false; kind: 'error'; message: string };

export type DecompileResult =
  | {
      ok: true;
      output: string;
      warnings: ImportWarning[];
      buildErrors: ConvDiagnostic[];
    }
  | { ok: false; kind: 'unsupported'; message: string }
  | { ok: false; kind: 'error'; message: string };
