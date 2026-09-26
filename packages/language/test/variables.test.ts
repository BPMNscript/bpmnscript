/**
 * `VariableSymbolProvider.collect`, the flat table of every name a process
 * declares, driven through the injected service on a parsed process.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type {
  Model,
  VariableSymbol,
  VariableSymbolProvider,
  VariableTable,
} from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';
import { formatParseFailure } from './helpers/parse-failure.js';

let provider: VariableSymbolProvider;
let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  provider = services.BpmnScript.references.VariableSymbolProvider;
  parse = parseHelper<Model>(services.BpmnScript);
});

const LOOP_COUNTERS: [string, VariableSymbol][] = [
  'nrOfInstances',
  'nrOfActiveInstances',
  'nrOfCompletedInstances',
  'loopCounter',
].map((name) => [name, { name, type: 'number' }]);

describe('the variable table of a process', () => {
  test.each<readonly [title: string, source: string, expected: VariableTable]>([
    [
      'a header var of every type enters with that type',
      `process p {
  var amount: number
  var name: string
  var flag: boolean
  var due: date
  var payload: json
  var misc: any
  start S
  end E
}`,
      new Map([
        ['amount', { name: 'amount', type: 'number' }],
        ['name', { name: 'name', type: 'string' }],
        ['flag', { name: 'flag', type: 'boolean' }],
        ['due', { name: 'due', type: 'date' }],
        ['payload', { name: 'payload', type: 'json' }],
        ['misc', { name: 'misc', type: 'any' }],
      ]),
    ],
    [
      'a process declaring nothing has an empty table',
      `process p { start S end E }`,
      new Map(),
    ],
    [
      'a field name stays out of the table while input and output names enter it',
      `process p {
  service S(class: "com.acme.D") {
    input amount = 1
    output result = "x"
    field greeting = "hello"
    on start(class: "com.acme.L") { field salutation = "hi" }
  }
}`,
      new Map([
        ['amount', { name: 'amount', type: 'any' }],
        ['result', { name: 'result', type: 'any' }],
      ]),
    ],
    [
      'a repeat element enters the table as any beside the loop counters',
      `process p {
  var items: json
  user U for each item in items
}`,
      new Map<string, VariableSymbol>([
        ['items', { name: 'items', type: 'json' }],
        ['item', { name: 'item', type: 'any' }],
        ...LOOP_COUNTERS,
      ]),
    ],
    [
      'a count alone seeds the loop counters, and a declared one keeps its own type',
      `process p {
  var loopCounter: string
  user U for 3
}`,
      new Map<string, VariableSymbol>([
        ['loopCounter', { name: 'loopCounter', type: 'string' }],
        ...LOOP_COUNTERS.filter(([name]) => name !== 'loopCounter'),
      ]),
    ],
  ])('%s', async (_title, source, expected) => {
    const document = await parse(source);
    expect(formatParseFailure(document)).toBeUndefined();
    const process = document.parseResult.value.processes[0]!;
    expect(provider.collect(process)).toEqual(expected);
  });
});
