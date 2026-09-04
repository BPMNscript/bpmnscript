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

// Every hop of DSL -> ir1 -> xml -> ir2 -> dsl -> ir3.
export interface RoundTripRun {
  ir1: BpmnProcess;
  xml: string;
  warnings: ImportWarning[];
  ir2: BpmnProcess;
  dsl: string;
  ir3: BpmnProcess;
}

export async function roundTrip(source: string): Promise<RoundTripRun> {
  const ir1 = astToIr(await parseToAst(source));
  const xml = await irToXml(ir1);
  const { ir: ir2, warnings } = await xmlToIr(xml);
  const dsl = irToDsl(ir2);
  return { ir1, xml, warnings, ir2, dsl, ir3: astToIr(await parseToAst(dsl)) };
}

// The returned run is filled by a beforeAll, so read it only from an `it` body.
export function roundTripOf(source: string): RoundTripRun {
  const run = {} as RoundTripRun;
  beforeAll(async () => {
    Object.assign(run, await roundTrip(source));
  });
  return run;
}
