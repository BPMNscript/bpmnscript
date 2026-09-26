// The checks every golden-pair suite shares; a suite adds its own in its file.

import { it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

import { DiagnosticSeverity } from 'vscode-languageserver-types';

import { expectSoundLayout } from './di-bounds.js';
import { normalizeIr } from './normalize-ir.js';
import { irHops, parseToAst, printDsl, validate } from './pipeline.js';
import type { IrHops } from './pipeline.js';

const GOLDEN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../golden',
);

export interface RoundTripOptions {
  // 'frozen' reads DSL' back out of the golden .bpmn instead of the generated XML.
  dslPrimeFrom?: 'generated' | 'frozen';
  // The frozen .bpmn imports warning-free and re-desugars normalized-equal to IR1.
  importPath?: boolean;
  // 'clean' checks every diagnostic on DSL'; 'errors' only error severity, for
  // fixtures with unnamed throws whose synthesized ids draw a reserved-name warning.
  recompile: 'errors' | 'clean';
}

export interface RoundTrip {
  fixtureSrc: string;
  frozenXml: string;
  generatedXml: string;
  ir1: BpmnProcess;
  ir2: BpmnProcess;
  ir3: BpmnProcess;
  hops: IrHops;
  dslPrime: string;
  // Filled only with `importPath`: the frozen .bpmn imported, printed and re-desugared.
  irFromImport: BpmnProcess;
  importWarnings: ImportWarning[];
}

// `name` is the basename the `.bpmnscript` and `.bpmn` share. The handle is
// filled by a beforeAll, so read it only from inside an `it` body.
export function roundTripFixture(
  name: string,
  options: RoundTripOptions,
): RoundTrip {
  const rt = {} as RoundTrip;
  const read = (ext: string): string =>
    readFileSync(resolve(GOLDEN_DIR, `${name}.${ext}`), 'utf-8');

  beforeAll(async () => {
    rt.fixtureSrc = read('bpmnscript');
    rt.frozenXml = read('bpmn');
    rt.ir1 = astToIr(await parseToAst(rt.fixtureSrc));
    rt.generatedXml = await irToXml(rt.ir1);
    ({ ir: rt.ir2 } = await xmlToIr(
      options.dslPrimeFrom === 'frozen' ? rt.frozenXml : rt.generatedXml,
    ));
    rt.dslPrime = printDsl(rt.ir2);
    rt.ir3 = astToIr(await parseToAst(rt.dslPrime));
    rt.hops = irHops(rt.ir1, rt.ir2, rt.ir3);
    if (options.importPath === true) {
      const imported = await xmlToIr(rt.frozenXml);
      rt.importWarnings = imported.warnings;
      rt.irFromImport = astToIr(await parseToAst(printDsl(imported.ir)));
    }
  });

  it('regenerates the frozen .bpmn byte for byte with a sound layout, round-trips to the same IR and opens validator-clean', async () => {
    expect(rt.generatedXml).toBe(rt.frozenXml);
    expectSoundLayout(rt.frozenXml, rt.ir1);
    expect(normalizeIr(rt.ir3)).toEqual(normalizeIr(rt.ir1));
    expect((await validate(rt.fixtureSrc)).diagnostics).toEqual([]);
    const { diagnostics } = await validate(rt.dslPrime);
    expect(
      diagnostics.filter(
        (d) =>
          options.recompile === 'clean' ||
          d.severity === DiagnosticSeverity.Error,
      ),
    ).toEqual([]);
    if (options.importPath === true) {
      expect(rt.importWarnings).toEqual([]);
      expect(normalizeIr(rt.irFromImport)).toEqual(normalizeIr(rt.ir1));
    }
  });

  return rt;
}
