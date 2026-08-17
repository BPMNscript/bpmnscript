/**
 * The scaffolding every golden pair suite shares: Langium wiring, the pipeline
 * run over one `tests/golden/<name>.bpmnscript` fixture and its frozen
 * `<name>.bpmn`, and the handful of assertions that mean the same thing in all
 * of them.
 *
 * The pipeline is
 *
 *   fixture.bpmnscript -> astToIr (IR₁) -> irToXml -> xmlToIr (IR₂)
 *                      -> irToDsl (DSL′) -> astToIr (IR₃)
 *
 * `roundTripFixture` registers the shared blocks and hands back a live handle
 * the calling suite reads in its own `it` bodies. The suites are not uniform, so
 * every place they genuinely differ is an option rather than something quietly
 * dropped: see {@link RoundTripOptions}. A suite that needs an extra assertion
 * inside a shared block re-opens that `describe` in its own file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { xmlToIr, irToDsl, astToIr, irToXml } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { normalizeIr } from './normalize-ir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GOLDEN_DIR = resolve(__dirname, '../golden');
const EXAMPLES_DIR = resolve(__dirname, '../../examples/spring-boot/processes');

export interface RoundTripOptions {
  /**
   * Basename of a deployable example under `examples/spring-boot/processes/`,
   * asserted validator-clean alongside the fixture. Only some constructs have
   * a matching deployable example.
   */
  example?: string;

  /**
   * Which XML the decompiled `DSL′` is read back out of. `'generated'` runs
   * `irToXml` output straight through; `'frozen'` re-reads the golden `.bpmn`
   * from disk, so a suite that only proves the frozen artifact decompiles is
   * driven by the file rather than by the generator.
   */
  dslPrimeFrom?: 'generated' | 'frozen';

  /**
   * Register the import-path block: the frozen artifact imports without
   * warnings and re-desugars normalized-equal to `IR₁`. Suites whose frozen
   * artifact is not the input to a second decompile leave it off.
   */
  importPath?: boolean;

  /**
   * How strictly `DSL′` validation is asserted, and where.
   *
   *   - `'errors'`: error-severity diagnostics only, inside the idempotence
   *     block. A fixture whose decompiled form legitimately raises warnings.
   *   - `'clean'`: every diagnostic, inside the idempotence block. Only for
   *     fixtures that name every throw and emit, so nothing synthesises an id
   *     the reserved-name check rejects.
   *   - `'errors-standalone'`: error-severity diagnostics only, in a
   *     `recompile-validity` block of its own.
   */
  recompile: 'errors' | 'clean' | 'errors-standalone';

  /**
   * Overrides the derived `[describe, it]` titles of the block asserting the
   * authored fixture opens validator-clean.
   */
  validatorCleanTitles?: [describeTitle: string, itTitle: string];
}

export interface RoundTrip {
  parse: ReturnType<typeof parseHelper<Model>>;
  validate: ReturnType<typeof validationHelper<Model>>;
  /**
   * Parse DSL source into a checked AST, throwing on any parser error. A
   * round-tripped source that does not re-parse is itself a round-trip failure.
   */
  parseToAst: (source: string) => Promise<Model>;

  /** The authored `tests/golden/<name>.bpmnscript`. */
  fixtureSrc: string;
  /** The frozen `tests/golden/<name>.bpmn`. */
  frozenXml: string;
  /** `irToXml(astToIr(parse(fixture)))`. */
  generatedXml: string;
  /** `astToIr(parse(fixture))`. */
  ir1: BpmnProcess;
  /** `xmlToIr(...)`, per `dslPrimeFrom`. */
  ir2: BpmnProcess;
  /** Re-desugared after DSL -> XML -> DSL′. */
  ir3: BpmnProcess;
  /** The restructured DSL after one XML round-trip. */
  dslPrime: string;
  /** Warnings from `xmlToIr(frozen)`; only filled when `importPath` is on. */
  importWarnings: Awaited<ReturnType<typeof xmlToIr>>['warnings'];
  /** `xmlToIr(frozen).ir` -> DSL -> re-desugared; only when `importPath` is on. */
  irFromImport: BpmnProcess;
}

/**
 * Wire up the pipeline for one golden pair and register the shared assertions.
 *
 * @param name - Basename shared by `<name>.bpmnscript` and `<name>.bpmn` under
 *   `tests/golden/`.
 * @param options - Where the suites diverge; see {@link RoundTripOptions}.
 * @returns A handle whose fields are filled by the registered `beforeAll`, so
 *   they are only readable from inside an `it` body.
 */
export function roundTripFixture(
  name: string,
  options: RoundTripOptions,
): RoundTrip {
  const services = createBpmnScriptServices(EmptyFileSystem);
  const parse = parseHelper<Model>(services.BpmnScript);
  const validate = validationHelper<Model>(services.BpmnScript);

  async function parseToAst(source: string): Promise<Model> {
    const document = await parse(source);
    const errors = document.parseResult.parserErrors;
    if (errors.length > 0) {
      throw new Error(
        'Parser errors in round-tripped DSL:\n' +
          errors.map((e) => e.message).join('\n'),
      );
    }
    return document.parseResult.value;
  }

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
      ? 'idempotence: golden .bpmn → IR₂ → DSL′ → IR₃'
      : 'idempotence: DSL → IR₁ → XML → IR₂ → DSL′ → IR₃';

  describe(idempotenceTitle, () => {
    it('normalizeIr(IR₁) equals normalizeIr(IR₃)', () => {
      expect(normalizeIr(rt.ir3)).toEqual(normalizeIr(rt.ir1));
    });

    it('the restructured DSL′ re-parses with zero parser errors', async () => {
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
      it('the restructured DSL′ is validator-clean (named throws re-parse cleanly)', async () => {
        const { diagnostics } = await validate(rt.dslPrime);
        expect(diagnostics).toEqual([]);
      });
    }
  });

  if (options.recompile === 'errors-standalone') {
    describe('recompile-validity: the decompiled DSL′ recompiles clean', () => {
      it('the decompiled DSL′ validates with zero error diagnostics', async () => {
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

      it('imported → DSL → re-desugared IR is normalized-equal to IR₁', () => {
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
