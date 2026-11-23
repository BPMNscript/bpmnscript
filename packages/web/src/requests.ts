import { compileDslToBpmn, decompileBpmnToDsl } from '@bpmn-script/conversion';
import type { CompileResult, DecompileResult } from '@bpmn-script/conversion';
import type { Connection } from 'vscode-languageserver';

export type {
  CompileResult,
  ConvDiagnostic,
  DecompileResult,
} from '@bpmn-script/conversion';

/** `{ source }` → {@link CompileResult}: BPMNscript to BPMN 2.0 XML. */
export const COMPILE_METHOD = 'bpmnscript/compile';
/** `{ xml }` → {@link DecompileResult}: BPMN 2.0 XML to BPMNscript. */
export const DECOMPILE_METHOD = 'bpmnscript/decompile';

export interface CompileParams {
  source: string;
}

export interface DecompileParams {
  xml: string;
}

/** Any failure, even a bad params object, comes back as a result, never as a JSON-RPC error. */
async function settle<T>(
  run: () => Promise<T>,
): Promise<T | { ok: false; kind: 'error'; message: string }> {
  try {
    return await run();
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `version` goes into the exported XML as `exporterVersion`. */
export function registerConversionRequests(
  connection: Connection,
  version: string,
): void {
  connection.onRequest(
    COMPILE_METHOD,
    (params: CompileParams): Promise<CompileResult> =>
      settle(() => compileDslToBpmn(params.source, version)),
  );
  connection.onRequest(
    DECOMPILE_METHOD,
    (params: DecompileParams): Promise<DecompileResult> =>
      settle(() => decompileBpmnToDsl(params.xml)),
  );
}
