import { beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr, irToDsl, irToXml, xmlToIr } from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

const services = createBpmnScriptServices(EmptyFileSystem);

export const parse = parseHelper<Model>(services.BpmnScript);
export const validate = validationHelper<Model>(services.BpmnScript);

// For suites that assert printed source; the warnings channel is covered where
// it lives.
export function printDsl(ir: BpmnProcess): string {
  return irToDsl(ir).source;
}

// Throws rather than returning: a round-tripped source that will not re-parse
// is itself a round-trip failure and must abort the test.
export async function parseToAst(source: string): Promise<Model> {
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

export type IrHops = readonly (readonly [label: string, ir: BpmnProcess])[];

export function irHops(
  ir1: BpmnProcess,
  ir2: BpmnProcess,
  ir3: BpmnProcess,
): IrHops {
  return [
    ['IR1', ir1],
    ['IR2', ir2],
    ['IR3', ir3],
  ];
}

export interface RoundTripRun {
  ir1: BpmnProcess;
  xml: string;
  warnings: ImportWarning[];
  ir2: BpmnProcess;
  dsl: string;
  ir3: BpmnProcess;
  hops: IrHops;
}

// The cli's build.ts and the extension's conversion-core.ts run the same
// astToIr -> irToXml chain, each with its own failure reporting; here a
// failure throws.
export async function roundTrip(source: string): Promise<RoundTripRun> {
  const ir1 = astToIr(await parseToAst(source));
  const xml = await irToXml(ir1);
  const { ir: ir2, warnings } = await xmlToIr(xml);
  const dsl = printDsl(ir2);
  const ir3 = astToIr(await parseToAst(dsl));
  return {
    ir1,
    xml,
    warnings,
    ir2,
    dsl,
    ir3,
    hops: irHops(ir1, ir2, ir3),
  };
}

// The returned run is filled by a beforeAll, so read it only from an `it` body.
export function roundTripOf(source: string): RoundTripRun {
  const run = {} as RoundTripRun;
  beforeAll(async () => {
    Object.assign(run, await roundTrip(source));
  });
  return run;
}

// The second pass starts from the first's printed DSL, catching a value that
// is stable on the first print but drifts on the second, which one hop each
// direction cannot see.
export interface RoundTripTwice {
  xml1: string;
  dsl1: string;
  xml2: string;
  dsl2: string;
}

export async function roundTripTwice(source: string): Promise<RoundTripTwice> {
  const first = await roundTrip(source);
  const second = await roundTrip(first.dsl);
  return {
    xml1: first.xml,
    dsl1: first.dsl,
    xml2: second.xml,
    dsl2: second.dsl,
  };
}
