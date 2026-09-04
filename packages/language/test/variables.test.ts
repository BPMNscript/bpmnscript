/**
 * Tests for the {@link VariableSymbolProvider} service.
 *
 * The provider turns a `Process` AST into a flat, position-independent variable
 * table (declared variable names → their Operaton-aligned types) that the
 * validators consult.
 *
 * The tests parse a process with `parseHelper` (no validation needed) and
 * exercise the provider directly.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { Model, Process, VarType } from '@bpmn-script/language';
import {
  createBpmnScriptServices,
  DefaultVariableSymbolProvider,
  type VariableSymbolProvider,
} from '@bpmn-script/language';
import { formatParseFailure } from './helpers/parse-failure.js';

let services: ReturnType<typeof createBpmnScriptServices>;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

describe('VariableSymbolProvider', () => {
  test('is registered as an injectable language service', () => {
    const provider: VariableSymbolProvider =
      services.BpmnScript.references.VariableSymbolProvider;
    expect(provider).toBeDefined();
    expect(typeof provider.collect).toBe('function');
  });

  test('collects declared variables with their types for a multi-var process', async () => {
    const process = await parseProcess(`
process p {
  var amount: number
  var name: string
  var flag: boolean
  var due: date
  var payload: json
  var misc: any
  start S
  end E
}
`);
    const table = newProvider().collect(process);
    expect(table.size).toBe(6);
    expect(table.get('amount')?.type).toBe<VarType>('number');
    expect(table.get('name')?.type).toBe<VarType>('string');
    expect(table.get('flag')?.type).toBe<VarType>('boolean');
    expect(table.get('due')?.type).toBe<VarType>('date');
    expect(table.get('payload')?.type).toBe<VarType>('json');
    expect(table.get('misc')?.type).toBe<VarType>('any');
  });

  test('a process with no var declarations yields an empty table', async () => {
    const process = await parseProcess(`process p { start S end E }`);
    expect(newProvider().collect(process).size).toBe(0);
  });

  test('collect() answers membership and type queries via the returned table', async () => {
    const process = await parseProcess(`
process p {
  var amount: number
  start S
  end E
}
`);
    const table = newProvider().collect(process);
    expect(table.has('amount')).toBe(true);
    expect(table.has('missing')).toBe(false);
    expect(table.get('amount')?.type).toBe<VarType>('number');
    expect(table.get('missing')?.type).toBeUndefined();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A fresh provider with no contributors. */
function newProvider(): VariableSymbolProvider {
  return new DefaultVariableSymbolProvider();
}

/** Parse a source string and return its single process, failing on parse error. */
async function parseProcess(source: string): Promise<Process> {
  const document = await parse(source.trim());
  const failure = formatParseFailure(document);
  if (failure) {
    throw new Error(`source failed to parse:\n${failure}`);
  }
  return document.parseResult.value.processes[0]!;
}
