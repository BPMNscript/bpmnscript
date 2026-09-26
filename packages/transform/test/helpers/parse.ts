import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { expect } from 'vitest';
import { createBpmnScriptServices, type Model } from '@bpmn-script/language';

import { astToIr } from '../../src/ast-to-ir.js';
import type { BpmnProcess } from '../../src/ir/types.js';

const services = createBpmnScriptServices(EmptyFileSystem).BpmnScript;

export const parse = parseHelper<Model>(services);
export const validate = validationHelper<Model>(services);

export async function ir(source: string): Promise<BpmnProcess> {
  const doc = await parse(source);
  expect(doc.parseResult.parserErrors).toHaveLength(0);
  return astToIr(doc.parseResult.value);
}
