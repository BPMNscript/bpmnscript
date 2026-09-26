import { describe, expect, it } from 'vitest';

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
import { ir } from './helpers/parse.js';

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

describe('form fields', () => {
  it('lower to IR, serialize to operaton:formData with number as long, and come back unchanged through XML and through printed source', async () => {
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

    const xml = await irToXml(process);
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

    const { ir: reimported, warnings } = await xmlToIr(xml);
    expect(warnings.filter((w) => /form/i.test(w.message))).toEqual([]);
    const reparsed = await ir(irToDsl(process).source);
    for (const back of [reimported, reparsed]) {
      expect(startOf(back).formFields).toEqual(startOf(process).formFields);
      expect(userOf(back).formFields).toEqual(userOf(process).formFields);
    }
  });

  it('are absent without a form block', async () => {
    const process = await ir('process p { start S user U }');
    expect(startOf(process).formFields).toBeUndefined();
    expect(userOf(process).formFields).toBeUndefined();
  });

  it('refuse on import a type the script cannot express, naming the five it takes', async () => {
    const xml = await irToXml(await ir(SOURCE));
    const err = await expectRefusal<UnsupportedFormFieldTypeError>(
      xmlToIr(xml.replace('type="long"', 'type="double"')),
      UnsupportedFormFieldTypeError,
    );
    expect(err.message).toMatch(
      /'double'.*string, long, boolean, date, and enum/,
    );
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
