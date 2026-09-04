// The editor-independent half of the conversion commands: what each direction
// makes of a given input. `conversion.test.ts` covers what the VS Code adapter
// then shows the author.

import { describe, expect, test, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { xmlToIr } from '@bpmn-script/transform';

import {
  compileDslToBpmn,
  decompileBpmnToDsl,
  swapExtension,
} from '../src/extension/conversion-core.js';
import type { ConvDiagnostic } from '../src/extension/conversion-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

const INVOICE_APPROVAL_SRC = path.resolve(
  REPO_ROOT,
  'examples/spring-boot/processes/invoice-approval.bpmnscript',
);

const GOLDEN_GENERATED_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/invoice-approval-generated.bpmn',
);

const BAD_SERVICE_TASK_BPMN = path.resolve(
  REPO_ROOT,
  'tests/golden/bad-service-task-no-binding.bpmn',
);

for (const [label, p] of [
  ['invoice-approval.bpmnscript', INVOICE_APPROVAL_SRC],
  ['invoice-approval-generated.bpmn', GOLDEN_GENERATED_BPMN],
  ['bad-service-task-no-binding.bpmn', BAD_SERVICE_TASK_BPMN],
] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`Fixture not found: ${label} at ${p}`);
  }
}

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

/** Every substring must appear, so a message that stops naming one fails. */
function expectMentions(text: string, mentions: readonly string[]): void {
  for (const mention of mentions) {
    expect(text, `expected to find "${mention}" in: ${text}`).toContain(
      mention,
    );
  }
}

/**
 * A diagnostic minus its wording: the positions, the severity and the source
 * text are this module's own mapping, the sentence belongs to the validator.
 */
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
      // String `name` in a numeric comparison: a severity-1 diagnostic.
      'a type mismatch blocks the compile and reports the comparison it rejected',
      `process p {\n  var name: string\n  if (name > 1000) { user A }\n}\n`,
      {
        ok: false,
        kind: 'validation',
        diagnostics: [
          {
            // 0-based, LSP convention.
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
      // Uses `amount` without declaring it: severity 2, which must not block.
      'an undeclared variable is only a warning, so the source still compiles',
      `process p { if (amount > 1000) { user A } }`,
      { ok: true, reimportsAs: 'p' },
    ],
  ])('%s', async (_title, source, expected) => {
    const result = await compileDslToBpmn(source, 'test.bpmnscript', '0.0.1');

    expect(result.ok).toBe(expected.ok);
    if (expected.ok) {
      if (!result.ok) return;
      expect(result.output).toContain('bpmn:definitions');
      expect((await xmlToIr(result.output)).ir.id).toBe(expected.reimportsAs);
      return;
    }

    if (result.ok) return;
    expect(result.kind).toBe(expected.kind);
    // The union type alone does not stop the adapter writing result.output if a
    // kind check goes missing, so assert the field is absent.
    expect('output' in result).toBe(false);
    if (result.kind !== 'validation') return;
    expect(
      result.diagnostics.map(({ message: _message, ...position }) => position),
    ).toEqual(expected.diagnostics);
    expect(result.diagnostics.map((d) => d.message.length > 0)).toEqual(
      expected.diagnostics.map(() => true),
    );
  });
});

// `formRef` and the lane are both dropped without loss of behavior, so
// `xmlToIr` warns instead of refusing.
const LANE_AND_ASYNC_ATTR_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="warns" isExecutable="true">
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
                   operaton:formRef="review-form" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="AsyncTask" />
    <bpmn:sequenceFlow id="F2" sourceRef="AsyncTask" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

const CONDITIONAL_START_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  targetNamespace="http://test">
  <bpmn:process id="conditional" isExecutable="true">
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
      'a BPMN this tool generated comes back with nothing to report',
      fs.readFileSync(GOLDEN_GENERATED_BPMN, 'utf-8'),
      { ok: true, warnings: [], mentions: [] },
    ],
    [
      'a lane and an unsupported engine attribute are dropped with a warning each, naming the element they came off',
      LANE_AND_ASYNC_ATTR_BPMN,
      {
        ok: true,
        warnings: [
          ['Lane_Ops', 'lane'],
          ['AsyncTask', 'extensionAttribute'],
        ],
        mentions: ['formRef'],
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
      'a conditional start event is refused, naming the event and its trigger',
      CONDITIONAL_START_BPMN,
      {
        ok: false,
        kind: 'unsupported',
        mentions: ['ConditionalStart', 'conditional'],
      },
    ],
  ])('%s', async (_title, xml, expected) => {
    const result = await decompileBpmnToDsl(xml, 'input.bpmn');

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
      // Whatever it accepts, it must hand back a script Langium accepts.
      const doc = await parse(result.output);
      expect(doc.parseResult.parserErrors).toHaveLength(0);
      return;
    }

    if (result.ok) return;
    expect(result.kind).toBe(expected.kind);
    expectMentions(result.message, expected.mentions);
  });
});

describe('swapExtension', () => {
  test.each([
    ['/a/b/my.invoice.bpmnscript', '.bpmn', '/a/b/my.invoice.bpmn'],
    ['/a/b/x.bpmn', '.bpmnscript', '/a/b/x.bpmnscript'],
  ] as const)(
    'only the final extension of %s is replaced by %s',
    (input, newExt, expected) => {
      expect(swapExtension(input, newExt)).toBe(expected);
    },
  );
});
