import { describe, expect, test, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import {
  compileDslToBpmn,
  decompileBpmnToDsl,
} from '../src/extension/conversion-core.js';
import type { ConvDiagnostic } from '../src/extension/conversion-core.js';

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

function expectMentions(text: string, mentions: readonly string[]): void {
  for (const mention of mentions) {
    expect(text, `expected to find "${mention}" in: ${text}`).toContain(
      mention,
    );
  }
}

// The wording belongs to the validator, the rest is this module's mapping.
type DiagnosticPosition = Omit<ConvDiagnostic, 'message'>;

type CompileOutcome =
  | { ok: true; reimportsAs: string }
  | { ok: false; kind: 'validation'; diagnostics: DiagnosticPosition[] };

type CompileRow = readonly [
  title: string,
  source: string,
  expected: CompileOutcome,
];

describe('compileDslToBpmn', () => {
  test.each<CompileRow>([
    [
      'the invoice-approval example compiles to BPMN that imports back under its own id',
      fs.readFileSync(INVOICE_APPROVAL_SRC, 'utf-8'),
      { ok: true, reimportsAs: 'invoice-approval' },
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
            severity: 1,
            text: 'name > 1000',
          },
        ],
      },
    ],
    [
      'an undeclared variable is only a warning, so the source still compiles',
      `process p { if (amount > 1000) { user A } }`,
      { ok: true, reimportsAs: 'p' },
    ],
  ])('%s', async (_title, source, expected) => {
    const result = await compileDslToBpmn(source, '0.0.1');

    expect(result.ok).toBe(expected.ok);
    if (expected.ok) {
      if (!result.ok) return;
      expect(result.output).toContain('bpmn:definitions');
      expect((await xmlToIr(result.output)).ir.id).toBe(expected.reimportsAs);
      return;
    }

    if (result.ok) return;
    expect(result.kind).toBe(expected.kind);
    expect('output' in result).toBe(false);
    if (result.kind !== 'validation') return;
    expect(
      result.diagnostics.map(({ message: _message, ...position }) => position),
    ).toEqual(expected.diagnostics);
    expect(result.diagnostics.map((d) => d.message.length > 0)).toEqual(
      expected.diagnostics.map(() => true),
    );
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
    expect(result.layoutWarning).toContain('bpmn-auto-layout');
  });

  test('a comment-only file is refused in plain words, not in astToIr wording', async () => {
    const result = await compileDslToBpmn(
      '// nothing but a comment here\n',
      '0.0.1',
    );

    expect(result).toEqual({
      ok: false,
      kind: 'error',
      message: 'the file has no process',
    });
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

type DecompileOutcome =
  | {
      ok: true;
      /** Every warning, as [element id, category], in the order reported. */
      warnings: (readonly [string, string])[];
      mentions: string[];
    }
  | { ok: false; kind: 'unsupported'; mentions: string[] };

type DecompileRow = readonly [
  title: string,
  xml: string,
  expected: DecompileOutcome,
];

describe('decompileBpmnToDsl', () => {
  test.each<DecompileRow>([
    [
      'a lane and an unsupported engine attribute are dropped with a warning each, naming the element they came off',
      LANE_AND_ASYNC_ATTR_BPMN,
      {
        ok: true,
        warnings: [
          ['Lane_Ops', 'lane'],
          ['AsyncTask', 'extensionAttribute'],
        ],
        mentions: ['formHandlerClass'],
      },
    ],
    [
      'a service task with no execution form is refused, naming the task and what it lacks',
      fs.readFileSync(BAD_SERVICE_TASK_BPMN, 'utf-8'),
      {
        ok: false,
        kind: 'unsupported',
        mentions: ['BadService_1', 'no execution discriminator'],
      },
    ],
    [
      'a conditional start event comes back as a script the compiler accepts',
      CONDITIONAL_START_BPMN,
      { ok: true, warnings: [], mentions: [] },
    ],
  ])('%s', async (_title, xml, expected) => {
    const result = await decompileBpmnToDsl(xml);

    expect(result.ok).toBe(expected.ok);
    if (expected.ok) {
      if (!result.ok) return;
      expect(result.warnings.map((w) => [w.elementId, w.category])).toEqual(
        expected.warnings,
      );
      expectMentions(
        result.warnings.map((w) => w.message).join('\n'),
        expected.mentions,
      );
      // Parsing alone accepts source the validator refuses. Warnings are
      // expected: a BPMN declares no variables.
      const { diagnostics } = await validate(result.output);
      expect(
        diagnostics.filter((d) => d.severity === 1).map((d) => d.message),
      ).toEqual([]);
      return;
    }

    if (result.ok) return;
    expect(result.kind).toBe(expected.kind);
    expectMentions(result.message, expected.mentions);
  });

  // The file picker offers every file, and the message goes into a
  // notification whole.
  const UNPARSABLE_TAG = '<bad\0tag' + 'z'.repeat(300);

  test.each([
    [
      'a long file that is not XML at all is named by a short preview of its start',
      'PK\u0003\u0004' + 'x'.repeat(300_000),
      `not an XML document (starts with "PK${'x'.repeat(38)}")`,
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
