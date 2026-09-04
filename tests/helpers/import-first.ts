// The other direction of a golden pair: a handwritten .bpmn is the source, and
// the DSL printed from it has to re-desugar onto what was imported. The two
// halves share no synthesized id, so only the structural re-key in
// normalize-ir makes them meet.

import { describe, it, expect, beforeAll } from 'vitest';

import { xmlToIr, astToIr } from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

import { normalizeIr } from './normalize-ir.js';
import { parseToAst, printDsl } from './pipeline.js';

export interface ImportFirst {
  ir: BpmnProcess;
  warnings: ImportWarning[];
  dsl: string;
  reDesugared: BpmnProcess;
}

// `extra` registers what is specific to the fixture. The handle it receives is
// filled by a beforeAll, so read it only from inside an `it` body.
export function describeImportFirst(
  what: string,
  xml: string,
  extra: (first: ImportFirst) => void = () => undefined,
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

    it('imports warning-free', () => {
      expect(first.warnings).toEqual([]);
    });

    extra(first);

    it('the re-desugared IR is normalized-equal to the import', () => {
      expect(normalizeIr(first.reDesugared)).toEqual(normalizeIr(first.ir));
    });
  });
}
