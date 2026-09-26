import { it, expect } from 'vitest';

import type { BpmnProcess, FormField } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { elementById } from './helpers/ir-query.js';

function formFieldsOf(
  container: BpmnProcess,
  id: string,
): FormField[] | undefined {
  const el = elementById(container, id);
  if (el.kind !== 'startEvent' && el.kind !== 'userTask') {
    throw new Error(`expected '${id}' to carry a form, found ${el.kind}`);
  }
  return el.formFields;
}

const rt = roundTripFixture('forms', {
  dslPrimeFrom: 'generated',
  importPath: true,
  recompile: 'clean',
});

const APPLIED_FORM: FormField[] = [
  {
    id: 'fullName',
    type: 'string',
    label: 'Full name',
    constraints: [
      { name: 'required' },
      { name: 'minlength', config: '2' },
      { name: 'maxlength', config: '80' },
    ],
  },
  {
    id: 'birthDate',
    type: 'date',
    label: 'Date of birth',
    datePattern: 'dd/MM/yyyy',
    constraints: [{ name: 'required' }],
  },
  {
    id: 'plan',
    type: 'enum',
    label: 'Membership plan',
    defaultValue: 'basic',
    values: [
      { id: 'basic', label: 'Basic' },
      { id: 'plus', label: 'Plus' },
      { id: 'family' },
    ],
    constraints: [{ name: 'required' }],
    properties: [
      { key: 'description', value: 'The plan sets the monthly fee' },
    ],
  },
  {
    id: 'newsletter',
    type: 'boolean',
    label: 'Send the newsletter?',
    defaultValue: 'false',
  },
];

const CONFIRM_PAYMENT_FORM: FormField[] = [
  {
    id: 'amount',
    type: 'number',
    label: 'Amount in euros',
    defaultValue: '0',
    constraints: [
      { name: 'min', config: '0' },
      { name: 'max', config: '5000' },
    ],
  },
  {
    id: 'iban',
    type: 'string',
    label: 'IBAN',
    constraints: [
      { name: 'validator', config: 'com.example.gym.IbanValidator' },
    ],
  },
  {
    id: 'reference',
    type: 'string',
    label: 'Payment reference',
    constraints: [{ name: 'readonly' }],
    properties: [
      { key: 'placeholder', value: 'Filled in by accounting' },
      { key: 'help', value: 'Leave it empty; accounting fills it in' },
    ],
  },
  {
    id: 'confirmed',
    type: 'boolean',
    label: 'Payment received?',
    constraints: [{ name: 'required' }],
  },
];

it('keeps every field extension at every hop and through import, written properties, validation, values in that order', () => {
  for (const [label, ir] of [
    ...rt.hops,
    ['imported', rt.irFromImport],
  ] as const) {
    expect(formFieldsOf(ir, 'Applied'), label).toStrictEqual(APPLIED_FORM);
    expect(formFieldsOf(ir, 'ConfirmPayment'), label).toStrictEqual(
      CONFIRM_PAYMENT_FORM,
    );
  }
  expect(rt.frozenXml).toContain(
    '<operaton:formField id="plan" label="Membership plan" type="enum" defaultValue="basic">\n' +
      '            <operaton:properties>\n' +
      '              <operaton:property id="description" value="The plan sets the monthly fee" />\n' +
      '            </operaton:properties>\n' +
      '            <operaton:validation>\n' +
      '              <operaton:constraint name="required" />\n' +
      '            </operaton:validation>\n' +
      '            <operaton:value id="basic" name="Basic" />\n' +
      '            <operaton:value id="plus" name="Plus" />\n' +
      '            <operaton:value id="family" />\n' +
      '          </operaton:formField>',
  );
  expect(rt.frozenXml).toContain(
    '<operaton:formField id="fullName" label="Full name" type="string">\n' +
      '            <operaton:validation>\n' +
      '              <operaton:constraint name="required" />\n' +
      '              <operaton:constraint name="minlength" config="2" />\n' +
      '              <operaton:constraint name="maxlength" config="80" />\n' +
      '            </operaton:validation>\n' +
      '          </operaton:formField>',
  );
});
