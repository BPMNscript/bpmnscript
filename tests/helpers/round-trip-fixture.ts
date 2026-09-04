// The shared blocks every golden-pair suite registers, listed under "What the
// pair tests do" in tests/golden/README.md. Suites differ only through
// RoundTripOptions; one needing an extra assertion re-opens the describe in its
// own file.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './normalize-ir.js';
import { parse, parseToAst, validate } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GOLDEN_DIR = resolve(__dirname, '../golden');
const EXAMPLES_DIR = resolve(__dirname, '../../examples/spring-boot/processes');

export interface RoundTripOptions {
  // Basename under examples/spring-boot/processes/, asserted validator-clean
  // alongside the fixture. Not every construct has one.
  example?: string;

  // Where DSL' is read back out of. 'frozen' re-reads the golden .bpmn from
  // disk, so the suite is driven by the file rather than by the generator.
  dslPrimeFrom?: 'generated' | 'frozen';

  // Registers the import-path block: the frozen artifact imports warning-free
  // and re-desugars normalized-equal to IR1.
  importPath?: boolean;

  // How strictly DSL' validation is asserted, and where. 'clean' checks every
  // diagnostic and only fits fixtures that name every throw and emit, so
  // nothing synthesizes an id the reserved-name check rejects; 'errors' checks
  // error severity only, for fixtures whose decompiled form does warn.
  // 'errors-standalone' is 'errors' in a block of its own.
  recompile: 'errors' | 'clean' | 'errors-standalone';

  validatorCleanTitles?: [describeTitle: string, itTitle: string];
}

export interface RoundTrip {
  parse: typeof parse;
  validate: typeof validate;
  parseToAst: (source: string) => Promise<Model>;

  fixtureSrc: string;
  frozenXml: string;
  generatedXml: string;
  // ir1 = astToIr(parse(fixture)); ir2 = xmlToIr(...) per dslPrimeFrom;
  // ir3 = re-desugared from DSL'.
  ir1: BpmnProcess;
  ir2: BpmnProcess;
  ir3: BpmnProcess;
  hops: readonly (readonly [label: string, ir: BpmnProcess])[];
  dslPrime: string;
  // The next two are only filled when `importPath` is on.
  importWarnings: Awaited<ReturnType<typeof xmlToIr>>['warnings'];
  irFromImport: BpmnProcess;
}

// `name` is the basename the `.bpmnscript` and `.bpmn` share. The returned
// handle is filled by a beforeAll, so read it only from inside an `it` body.
export function roundTripFixture(
  name: string,
  options: RoundTripOptions,
): RoundTrip {
  const rt = { parse, validate, parseToAst } as RoundTrip;
  let exampleSrc: string;

  beforeAll(async () => {
    rt.fixtureSrc = readFileSync(
      resolve(GOLDEN_DIR, `${name}.bpmnscript`),
      'utf-8',
    );
    rt.frozenXml = readFileSync(resolve(GOLDEN_DIR, `${name}.bpmn`), 'utf-8');
    if (options.example !== undefined) {
      exampleSrc = readFileSync(
        resolve(EXAMPLES_DIR, `${options.example}.bpmnscript`),
        'utf-8',
      );
    }

    rt.ir1 = astToIr(await parseToAst(rt.fixtureSrc));
    rt.generatedXml = await irToXml(rt.ir1);

    ({ ir: rt.ir2 } = await xmlToIr(
      options.dslPrimeFrom === 'frozen' ? rt.frozenXml : rt.generatedXml,
    ));
    rt.dslPrime = irToDsl(rt.ir2);
    rt.ir3 = astToIr(await parseToAst(rt.dslPrime));
    rt.hops = [
      ['IR1', rt.ir1],
      ['IR2', rt.ir2],
      ['IR3', rt.ir3],
    ];

    if (options.importPath === true) {
      const imported = await xmlToIr(rt.frozenXml);
      rt.importWarnings = imported.warnings;
      rt.irFromImport = astToIr(await parseToAst(irToDsl(imported.ir)));
    }
  });

  describe('golden generation: the pipeline output matches the frozen .bpmn', () => {
    it('irToXml(astToIr(parse(fixture))) equals the frozen artifact byte-for-byte', () => {
      expect(rt.generatedXml).toBe(rt.frozenXml);
    });
  });

  const idempotenceTitle =
    options.dslPrimeFrom === 'frozen'
      ? "idempotence: golden .bpmn -> IR2 -> DSL' -> IR3"
      : "idempotence: DSL -> IR1 -> XML -> IR2 -> DSL' -> IR3";

  describe(idempotenceTitle, () => {
    it('normalizeIr(IR1) equals normalizeIr(IR3)', () => {
      expect(normalizeIr(rt.ir3)).toEqual(normalizeIr(rt.ir1));
    });

    it("the restructured DSL' re-parses with zero parser errors", async () => {
      const document = await parse(rt.dslPrime);
      expect(document.parseResult.parserErrors).toHaveLength(0);
    });

    if (options.recompile === 'errors') {
      it('the decompiled DSL recompiles without validation errors', async () => {
        const { diagnostics } = await validate(rt.dslPrime);
        expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
      });
    }

    if (options.recompile === 'clean') {
      it("the restructured DSL' is validator-clean (named throws re-parse cleanly)", async () => {
        const { diagnostics } = await validate(rt.dslPrime);
        expect(diagnostics).toEqual([]);
      });
    }
  });

  if (options.recompile === 'errors-standalone') {
    describe("recompile-validity: the decompiled DSL' recompiles clean", () => {
      it("the decompiled DSL' validates with zero error diagnostics", async () => {
        const { diagnostics } = await validate(rt.dslPrime);
        expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
      });
    });
  }

  if (options.importPath === true) {
    describe('import path: the frozen artifact imports cleanly and round-trips', () => {
      it('xmlToIr(frozen) produces no warnings', () => {
        expect(rt.importWarnings).toEqual([]);
      });

      it('imported -> DSL -> re-desugared IR is normalized-equal to IR1', () => {
        expect(normalizeIr(rt.irFromImport)).toEqual(normalizeIr(rt.ir1));
      });
    });
  }

  const [cleanDescribe, cleanIt] = options.validatorCleanTitles ?? [
    options.example !== undefined
      ? 'the authored programs open validator-clean'
      : 'the authored program opens validator-clean',
    'the fixture produces no diagnostics at all',
  ];

  describe(cleanDescribe, () => {
    it(cleanIt, async () => {
      const { diagnostics } = await validate(rt.fixtureSrc);
      expect(diagnostics).toEqual([]);
    });

    if (options.example !== undefined) {
      it('the deployable example produces no diagnostics at all', async () => {
        const { diagnostics } = await validate(exampleSrc);
        expect(diagnostics).toEqual([]);
      });
    }
  });

  return rt;
}
