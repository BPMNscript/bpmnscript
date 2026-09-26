/**
 * A `form { ... }` block on a `start` or a `user` task becomes an
 * `operaton:formData` extension element, with the DSL `number` type written
 * as Operaton's `long`; one suite per transform direction.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr } from '../src/ast-to-ir.js';
import { irToXml } from '../src/ir-to-xml.js';
import { xmlToIr } from '../src/xml-to-ir.js';
import { irToDsl } from '../src/ir-to-dsl.js';
import { UnsupportedFormFieldTypeError } from '../src/errors.js';
import { expectRefusal } from './helpers/expect-refusal.js';
import type {
  BpmnProcess,
  FormConstraintName,
  FormField,
  StartEvent,
  UserTask,
} from '../src/ir/types.js';

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

async function ir(source: string): Promise<BpmnProcess> {
  const doc = await parse(source);
  expect(doc.parseResult.parserErrors).toHaveLength(0);
  return astToIr(doc.parseResult.value);
}

const startOf = (process: BpmnProcess): StartEvent =>
  process.flowElements.find((e) => e.kind === 'startEvent') as StartEvent;

const userOf = (process: BpmnProcess): UserTask =>
  process.flowElements.find((e) => e.kind === 'userTask') as UserTask;

const SOURCE = `process loan(label: "Loan") {
  start RequestReceived {
    form {
      amount: number "Loan amount"
      creditScore: number "Credit score" = 700
    }
  }
  user Approve(label: "Approve loan", assignee: "demo") {
    form { approved: boolean "Approve the loan?" = false }
  }
}`;

describe('astToIr: form blocks lower to IR form fields', () => {
  it('reads start-event and user-task form fields', async () => {
    const process = await ir(SOURCE);

    expect(startOf(process).formFields).toEqual<FormField[]>([
      { id: 'amount', type: 'number', label: 'Loan amount' },
      {
        id: 'creditScore',
        type: 'number',
        label: 'Credit score',
        defaultValue: '700',
      },
    ]);
    expect(userOf(process).formFields).toEqual<FormField[]>([
      {
        id: 'approved',
        type: 'boolean',
        label: 'Approve the loan?',
        defaultValue: 'false',
      },
    ]);
  });

  it('omits formFields when there is no form block', async () => {
    const process = await ir('process p { start S user U }');
    expect(startOf(process).formFields).toBeUndefined();
    expect(userOf(process).formFields).toBeUndefined();
  });
});

describe('irToXml: form fields serialize to operaton:formData', () => {
  it('emits formData/formField, mapping number to long', async () => {
    const xml = await irToXml(await ir(SOURCE));

    expect(
      xml.match(/<operaton:formData>[\s\S]*?<\/operaton:formData>/g),
    ).toEqual([
      '<operaton:formData>\n' +
        '          <operaton:formField id="amount" label="Loan amount" type="long" />\n' +
        '          <operaton:formField id="creditScore" label="Credit score" type="long" defaultValue="700" />\n' +
        '        </operaton:formData>',
      '<operaton:formData>\n' +
        '          <operaton:formField id="approved" label="Approve the loan?" type="boolean" defaultValue="false" />\n' +
        '        </operaton:formData>',
    ]);
  });
});

describe('xmlToIr: form fields round-trip through XML', () => {
  it('recovers form fields (long -> number) with no drop warning', async () => {
    const original = await ir(SOURCE);
    const xml = await irToXml(original);
    const { ir: reimported, warnings } = await xmlToIr(xml);

    expect(warnings.filter((w) => /form/i.test(w.message))).toHaveLength(0);

    expect(startOf(reimported).formFields).toEqual(
      startOf(original).formFields,
    );
    expect(userOf(reimported).formFields).toEqual(userOf(original).formFields);
  });

  it('refuses a form field type the DSL cannot express, naming the five it takes', async () => {
    const xml = await irToXml(await ir(SOURCE));
    const withDouble = xml.replace('type="long"', 'type="double"');
    const err = await expectRefusal<UnsupportedFormFieldTypeError>(
      xmlToIr(withDouble),
      UnsupportedFormFieldTypeError,
    );
    expect(err.message).toMatch(
      /'double'.*string, long, boolean, date, and enum/,
    );
  });
});

describe('irToDsl: form fields round-trip back to a form block', () => {
  it('re-emits form blocks that re-desugar to the same fields', async () => {
    const original = await ir(SOURCE);
    const dsl = irToDsl(original).source;

    expect(dsl).toContain('form {');
    expect(dsl).toContain('amount: number "Loan amount"');
    expect(dsl).toContain('approved: boolean "Approve the loan?" = false');

    const reparsed = await ir(dsl);
    expect(startOf(reparsed).formFields).toEqual(startOf(original).formFields);
    expect(userOf(reparsed).formFields).toEqual(userOf(original).formFields);
  });
});

describe('astToIr: constraints, values, pattern and properties lower to the field', () => {
  const CONSTRAINT_SOURCE = `process p {
  start S {
    form {
      plan: string "Plan" (pattern: "dd/MM/yyyy", maxlength: 10, required: true, minlength: 2) {
        property description = "Sets the fee"
        property helpText = "See docs"
      }
      choice: enum "Choice" {
        basic "Basic"
        plus
        property note = "n/a"
      }
      blank: string
    }
  }
}`;

  it('reads a field whole: parens settings split into a pattern and ordered constraints, block members into values and properties, an empty field carrying none of them', async () => {
    const process = await ir(CONSTRAINT_SOURCE);

    expect(startOf(process).formFields).toEqual<FormField[]>([
      {
        id: 'plan',
        type: 'string',
        label: 'Plan',
        datePattern: 'dd/MM/yyyy',
        constraints: [
          { name: 'maxlength', config: '10' },
          { name: 'required' },
          { name: 'minlength', config: '2' },
        ],
        properties: [
          { key: 'description', value: 'Sets the fee' },
          { key: 'helpText', value: 'See docs' },
        ],
      },
      {
        id: 'choice',
        type: 'enum',
        label: 'Choice',
        values: [{ id: 'basic', label: 'Basic' }, { id: 'plus' }],
        properties: [{ key: 'note', value: 'n/a' }],
      },
      { id: 'blank', type: 'string' },
    ]);
  });

  const configRows: Array<[string, string, FormConstraintName, string]> = [
    ['a quoted negative number keeps its text', 'min: "-5"', 'min', '-5'],
    ['a bare negative number keeps its sign', 'min: -5', 'min', '-5'],
    [
      'a bare dotted class name reads like a class: binding',
      'validator: com.example.Check',
      'validator',
      'com.example.Check',
    ],
    [
      'a raw EL expression keeps its ${...} wrapper',
      'validator: "${checker}"',
      'validator',
      '${checker}',
    ],
  ];

  it.each(configRows)('%s', async (_title, setting, name, config) => {
    const process = await ir(
      `process p { start S { form { f: number (${setting}) } } }`,
    );

    expect(startOf(process).formFields).toEqual<FormField[]>([
      { id: 'f', type: 'number', constraints: [{ name, config }] },
    ]);
  });
});
