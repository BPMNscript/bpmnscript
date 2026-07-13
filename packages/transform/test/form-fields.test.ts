/**
 * Form-field support across the whole pipeline.
 *
 * A `form { … }` block on a `start` event or `user` task becomes an
 * `operaton:formData` extension element so Operaton Tasklist renders a labeled
 * form. These tests pin every transform in both directions:
 *   - `astToIr`  — the AST form block lowers to IR `formFields`.
 *   - `irToXml`  — IR form fields serialize to `operaton:formData`/`formField`,
 *                  mapping the DSL `number` type to Operaton `long`.
 *   - `xmlToIr`  — the extension element is read back (no spurious drop warning),
 *                  mapping `long` to `number`; an unmappable type is refused.
 *   - `irToDsl`  — form fields round-trip back to a `form { … }` block.
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
import type {
  BpmnProcess,
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

function startOf(process: BpmnProcess): StartEvent {
  const s = process.flowElements.find((e) => e.kind === 'startEvent');
  return s as StartEvent;
}

function userOf(process: BpmnProcess): UserTask {
  const u = process.flowElements.find((e) => e.kind === 'userTask');
  return u as UserTask;
}

const SOURCE = `process loan "Loan" {
  start RequestReceived {
    form {
      amount: number "Loan amount"
      creditScore: number "Credit score" = 700
    }
  }
  user Approve "Approve loan" {
    assignee = "demo"
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

    expect(xml).toContain('operaton:formData');
    expect(xml).toContain('operaton:formField');
    // number → long, boolean stays boolean.
    expect(xml).toMatch(/id="amount"[^>]*type="long"/);
    expect(xml).toMatch(/id="creditScore"[^>]*type="long"/);
    expect(xml).toMatch(/id="approved"[^>]*type="boolean"/);
    expect(xml).toContain('label="Loan amount"');
    expect(xml).toContain('defaultValue="700"');
    expect(xml).toContain('defaultValue="false"');
  });
});

describe('xmlToIr: form fields round-trip through XML', () => {
  it('recovers form fields (long → number) with no drop warning', async () => {
    const original = await ir(SOURCE);
    const xml = await irToXml(original);
    const { ir: reimported, warnings } = await xmlToIr(xml);

    // No warning about the formData extension element being dropped.
    expect(warnings.filter((w) => /form/i.test(w.message))).toHaveLength(0);

    expect(startOf(reimported).formFields).toEqual(
      startOf(original).formFields,
    );
    expect(userOf(reimported).formFields).toEqual(userOf(original).formFields);
  });

  it('refuses a form field type the DSL cannot express', async () => {
    const xml = await irToXml(await ir(SOURCE));
    const withDouble = xml.replace('type="long"', 'type="double"');
    await expect(xmlToIr(withDouble)).rejects.toThrow(
      UnsupportedFormFieldTypeError,
    );
  });
});

describe('irToDsl: form fields round-trip back to a form block', () => {
  it('re-emits form blocks that re-desugar to the same fields', async () => {
    const original = await ir(SOURCE);
    const dsl = irToDsl(original);

    expect(dsl).toContain('form {');
    expect(dsl).toContain('amount: number "Loan amount"');
    expect(dsl).toContain('approved: boolean "Approve the loan?" = false');

    const reparsed = await ir(dsl);
    expect(startOf(reparsed).formFields).toEqual(startOf(original).formFields);
    expect(userOf(reparsed).formFields).toEqual(userOf(original).formFields);
  });
});
