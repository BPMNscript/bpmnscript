// Every extension a form field takes sits in one artifact, so a constraint,
// value, pattern or property that stops travelling in any direction, or one
// that appears from nowhere, fails the whole-array comparison below.

import { describe, it, expect } from 'vitest';

import type { BpmnProcess, FormField } from '@bpmn-script/transform';

import { roundTripFixture } from './helpers/round-trip-fixture.js';
import { elementById } from './helpers/ir-query.js';

// Only a start event and a user task carry a form; narrowing here keeps the
// contract test itself free of `kind` bookkeeping.
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

describe('the frozen form-field contract', () => {
  it('every field keeps its constraints, values, pattern and properties at every hop and through import', () => {
    const runs: (readonly [label: string, ir: BpmnProcess])[] = [
      ...rt.hops,
      ['imported', rt.irFromImport],
    ];
    for (const [label, ir] of runs) {
      expect(
        formFieldsOf(ir, 'Applied'),
        `Applied.formFields differs in ${label}`,
      ).toStrictEqual(APPLIED_FORM);
      expect(
        formFieldsOf(ir, 'ConfirmPayment'),
        `ConfirmPayment.formFields differs in ${label}`,
      ).toStrictEqual(CONFIRM_PAYMENT_FORM);
    }
  });

  it("the frozen 'plan' element writes its properties, validation and values in that order", () => {
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
  });

  it("the frozen 'fullName' element writes 'required' with no config", () => {
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
});

// The fixture has no nested container (an `if`/`else` between two flat tasks),
// so there is nothing for describeDiContainment to walk, the same reason
// intermediate-catch leaves it out.
