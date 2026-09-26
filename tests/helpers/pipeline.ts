import { beforeAll } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

import {
  astToIr,
  irToDsl,
  irToXml,
  LayoutError,
  xmlToIr,
} from '@bpmn-script/transform';
import type { BpmnProcess, ImportWarning } from '@bpmn-script/transform';

const services = createBpmnScriptServices(EmptyFileSystem);

export const parse = parseHelper<Model>(services.BpmnScript);
export const validate = validationHelper<Model>(services.BpmnScript);

export async function validationErrors(source: string): Promise<string[]> {
  const { diagnostics } = await validate(source);
  return diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => Diagnostic.getMessageString(d));
}

export function printDsl(ir: BpmnProcess): string {
  return irToDsl(ir).source;
}

// Throws: DSL that will not re-parse is itself a round-trip failure.
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

// Like the cli and the extension, a layout failure keeps the diagram-less XML,
// since the model it carries is complete.
export async function roundTrip(source: string): Promise<RoundTripRun> {
  const ir1 = astToIr(await parseToAst(source));
  const xml = await irToXml(ir1).catch((e: unknown) => {
    if (e instanceof LayoutError) return e.xml;
    throw e;
  });
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
// drifts only on the second print.
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
