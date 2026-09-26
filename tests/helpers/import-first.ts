// A handwritten .bpmn as the source: the DSL printed from it must re-desugar
// onto the import. The two share no synthesized id, so only normalizeIr's
// structural re-key makes them meet.

import { describe, it, expect, beforeAll } from 'vitest';

import { xmlToIr, astToIr } from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

import { normalizeIr } from './normalize-ir.js';
import { parseToAst, printDsl } from './pipeline.js';

export const camundaAliasWarning = (elementId: string): ImportWarning => ({
  elementId,
  category: 'rewritten',
  message:
    'The file declares the camunda namespace; it was read as the operaton ' +
    'namespace, since `BpmnParse.OPERATON_BPMN_EXTENSIONS_NS` falls back ' +
    'to the camunda URI wherever the operaton spelling is absent, and the ' +
    'document written back carries `operaton:` alone.',
});

export interface ImportFirst {
  ir: BpmnProcess;
  warnings: ImportWarning[];
  dsl: string;
  reDesugared: BpmnProcess;
}

// The handle `extra` receives is filled by a beforeAll; read it only in an `it`.
export function describeImportFirst(
  what: string,
  xml: string,
  extra: (first: ImportFirst) => void = () => undefined,
  expectedWarnings: ImportWarning[] = [],
): void {
  const first = {} as ImportFirst;

  describe(`import-first: ${what}`, () => {
    beforeAll(async () => {
      const imported = await xmlToIr(xml);
      first.ir = imported.ir;
      first.warnings = imported.warnings;
      first.dsl = printDsl(first.ir);
      first.reDesugared = astToIr(await parseToAst(first.dsl));
    });

    it('imports with exactly the expected warnings and re-desugars normalized-equal to the import', () => {
      expect(first.warnings).toEqual(expectedWarnings);
      expect(normalizeIr(first.reDesugared)).toEqual(normalizeIr(first.ir));
    });

    extra(first);
  });
}
