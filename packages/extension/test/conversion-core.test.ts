import { describe, expect, test, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import { createBpmnScriptServices, Diagnostic } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import {
  compileDslToBpmn,
  decompileBpmnToDsl,
} from '../src/extension/conversion-core.js';
import type {
  CompileResult,
  DecompileResult,
} from '../src/extension/conversion-core.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-no-binding.bpmn',
);

let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

type CompileRow = readonly [
  title: string,
  source: string,
  /** The process id the output imports back as, or the whole failure. */
  expected: string | Extract<CompileResult, { ok: false }>,
];

describe('compileDslToBpmn', () => {
  test.each<CompileRow>([
    [
      'the invoice-approval example compiles to BPMN that imports back under its own id',
      fs.readFileSync(INVOICE_APPROVAL_SRC, 'utf-8'),
      'invoice-approval',
    ],
    [
      'a type mismatch blocks the compile and reports the comparison it rejected',
      `process p {\n  var name: string\n  if (name > 1000) { user A }\n}\n`,
      {
        ok: false,
        kind: 'validation',
        diagnostics: [
          {
            line: 2,
            character: 6,
            endLine: 2,
            endCharacter: 17,
            message:
              "variable 'name' of type 'string' cannot be used in an ordered comparison with '>'",
            severity: 1,
            text: 'name > 1000',
          },
        ],
      },
    ],
    [
      'an undeclared variable is only a warning, so the source still compiles',
      `process p { if (amount > 1000) { user A } }`,
      'p',
    ],
    [
      'a comment-only file is refused in plain words, not in astToIr wording',
      '// nothing but a comment here\n',
      { ok: false, kind: 'error', message: 'the file has no process' },
    ],
  ])('%s', async (_title, source, expected) => {
    const result = await compileDslToBpmn(source, '0.0.1');

    if (typeof expected !== 'string') {
      expect(result).toEqual(expected);
      return;
    }
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect((await xmlToIr(result.output)).ir.id).toBe(expected);
  });

  // `bpmn-auto-layout`'s grid solver throws on this validator-clean shape: a
  // mixed true/false/expression `else if` chain feeding one `goto` each.
  test('a layouter crash on a validator-clean goto graph still compiles, without a diagram, and reports why', async () => {
    const source = `process p {
  if (true) {
    goto L
  } else if (a.b) {
    goto U
  } else if (false) {
  }
  receive R
  end E
  emit compensation L
  user U
  end H
}
`;

    const result = await compileDslToBpmn(source, '0.0.1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('<bpmn:process');
    expect(result.output).not.toContain('bpmndi:');
    expect(result.layoutWarning).toMatch(
      /^'bpmn-auto-layout' failed to lay out the process: \S/,
    );
  });
});

const LANE_AND_ASYNC_ATTR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="warns" isExecutable="true" operaton:historyTimeToLive="P30D">
    <bpmn:laneSet id="LS1">
      <bpmn:lane id="Lane_Ops" name="Ops">
        <bpmn:flowNodeRef>S</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>AsyncTask</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>E</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="AsyncTask" name="Async Task"
                   operaton:assignee="alice" operaton:asyncBefore="true"
                   operaton:formHandlerClass="com.example.FormHandler" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

const CONDITIONAL_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  targetNamespace="http://test">
  <bpmn:process id="conditional" isExecutable="true" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" operaton:historyTimeToLive="P30D">
    <bpmn:startEvent id="ConditionalStart">
      <bpmn:conditionalEventDefinition id="cd">
        <bpmn:condition xsi:type="bpmn:tFormalExpression">\${stockLevel &lt; 5}</bpmn:condition>
      </bpmn:conditionalEventDefinition>
    </bpmn:startEvent>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="ConditionalStart" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

// A number field whose default the engine's `LongFormType` cannot convert:
// imported as written, refused by the validator.
const DECIMAL_DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="decimal-default-carry" isExecutable="true" operaton:historyTimeToLive="P30D">
    <bpmn:startEvent id="S" />
    <bpmn:userTask id="Review">
      <bpmn:extensionElements>
        <operaton:formData>
          <operaton:formField id="amount" type="long" defaultValue="1.5" />
        </operaton:formData>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Review" />
    <bpmn:sequenceFlow id="F1" sourceRef="Review" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

describe('decompileBpmnToDsl', () => {
  test.each<[title: string, xml: string, expected: DecompileResult]>([
    [
      'a lane and an unsupported engine attribute are dropped with a warning each, naming the element they came off',
      LANE_AND_ASYNC_ATTR_BPMN,
      {
        ok: true,
        output: `process warns {
  start S
  user AsyncTask(assignee: "alice", asyncBefore: true)
  end E
}
`,
        warnings: [
          {
            elementId: 'Lane_Ops',
            category: 'lane',
            message:
              "lane 'Ops' (Lane_Ops) was not imported\n" +
              'note: every step is placed in a single flat process',
          },
          {
            elementId: 'AsyncTask',
            category: 'extensionAttribute',
            message:
              "setting 'operaton:formHandlerClass' on 'AsyncTask' was not imported\n" +
              "note: BPMNscript reads no such setting on a 'bpmn:userTask'\n" +
              'note: the rebuilt document carries none',
          },
        ],
        buildErrors: [],
      },
    ],
    [
      'a service task with no execution form is refused, naming the task and what it lacks',
      fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8'),
      {
        ok: false,
        kind: 'unsupported',
        message:
          "service task 'BadService_1' uses an unsupported execution form: no execution discriminator\n" +
          'note: the supported forms are a Java class, an expression, a delegate expression, an external task topic, a built-in mail or shell task with its fields, or a decision reference on a business rule task\n' +
          "note: their attributes are 'operaton:class' (or the deprecated 'camunda:class' alias), 'operaton:expression', 'operaton:delegateExpression', 'operaton:type=\"external\"' with 'operaton:topic', 'operaton:type=\"mail\"' or 'operaton:type=\"shell\"' with their 'operaton:field' children, and 'operaton:decisionRef'",
      },
    ],
    [
      'a conditional start event comes back as a script the compiler accepts',
      CONDITIONAL_START_BPMN,
      {
        ok: true,
        output: `process conditional {
  var stockLevel: any
  start ConditionalStart condition(stockLevel < 5)
  end E
}
`,
        warnings: [],
        buildErrors: [],
      },
    ],
    [
      'the printed script is re-validated, so an error it draws is reported while the script is still returned',
      DECIMAL_DEFAULT_BPMN,
      {
        ok: true,
        output: `process decimal-default-carry {
  start S
  user Review {
    form {
      amount: number = 1.5
    }
  }
  end E
}
`,
        warnings: [
          {
            elementId: 'Review',
            category: 'carriedAsWritten',
            message:
              "the engine cannot use default '1.5' on form field 'amount' of 'Review' as written\n" +
              "note: 'LongFormType.convertValue' parses it with 'Long.valueOf' on every render of the form, and it is not an integer\n" +
              'note: it was imported as written, and the printed script draws an error at the field',
          },
        ],
        buildErrors: [
          {
            line: 4,
            character: 23,
            endLine: 4,
            endCharacter: 26,
            message:
              "the default 1.5 of number field 'amount' is not an integer\n" +
              'note: the engine converts it with Long.valueOf every time the form renders and throws on anything else',
            severity: 1,
            text: '1.5',
          },
        ],
      },
    ],
  ])('%s', async (_title, xml, expected) => {
    const result = await decompileBpmnToDsl(xml);

    expect(result).toEqual(expected);
    if (!result.ok) return;
    // Parsing alone accepts source the validator refuses, so the script goes
    // through the validator, whose errors are exactly the reported ones.
    const { diagnostics } = await validate(result.output);
    expect(
      diagnostics
        .filter((d) => d.severity === 1)
        .map((d) => Diagnostic.getMessageString(d)),
    ).toEqual(result.buildErrors.map((e) => e.message));
  });

  // The file picker offers every file, and the message goes into a
  // notification whole.
  const UNPARSABLE_TAG = '<bad\0tag' + 'z'.repeat(300);

  test.each([
    [
      'a long file that is not XML at all is named by a short preview of its start',
      'PK\u0003\u0004' + 'x'.repeat(300_000),
      `not an XML document (starts with 'PK${'x'.repeat(38)}')`,
    ],
    [
      'a document the parser chokes on is cut to its first line, capped, and stripped of control characters',
      UNPARSABLE_TAG,
      (
        `unparsable content ${UNPARSABLE_TAG} detected`.slice(0, 200) + '...'
      ).replace(/\p{C}/gu, ''),
    ],
  ])('%s', async (_title, xml, message) => {
    expect(await decompileBpmnToDsl(xml)).toEqual({
      ok: false,
      kind: 'error',
      message,
    });
  });
});
