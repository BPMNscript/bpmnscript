// The decompile contract on the two fixtures that carry it: what the import
// keeps, what it warns about, what it refuses, and that the script it hands
// back compiles again. `build-parse.smoke.test.ts` covers the commands
// themselves.

import { describe, it, test, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import {
  xmlToIr,
  irToDsl,
  UnsupportedConstructError,
  UnsupportedEventDefinitionError,
} from '@bpmn-script/transform';

import { diagnosticMessage } from '../src/util.js';
import { runBuild, runParse, expectMentions } from './helpers/actions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

const LANES_AND_ASYNC_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/lanes-and-async.bpmn',
);

const CONDITIONAL_START_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/conditional-start.bpmn',
);

// `StartEvent_1`/`EndEvent_1` are what a modeler mints for a start and an end
// drawn without a name of their own, and the shape the desugarer reserves for
// the ids it generates, so a script cannot spell either one back.
const GENERATED_ID_LABELS_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test">
  <bpmn:process id="generated-id-labels" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Order received" />
    <bpmn:userTask id="Approve" />
    <bpmn:endEvent id="EndEvent_1" name="Order filed" />
    <bpmn:sequenceFlow id="F1" sourceRef="StartEvent_1" targetRef="Approve" />
    <bpmn:sequenceFlow id="F2" sourceRef="Approve" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>
`;

// BPMN vocabulary the DSL author never sees (ADR-0013).
const FORBIDDEN_JARGON = ['flow node', 'gateway', 'token', 'sequence flow'];

function assertNoForbiddenJargon(text: string): void {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN_JARGON) {
    expect(
      lower,
      `message must not use BPMN jargon "${word}": ${text}`,
    ).not.toContain(word);
  }
}

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
});

describe('decompile contract: what the import makes of a fixture', () => {
  it('the lanes-and-async fixture imports into the supported subset, keeping the engine settings the IR carries and warning once per dropped item', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir, warnings } = await xmlToIr(xml);

    expect(ir.id).toBe('lanes-and-async');
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'userTask',
      'endEvent',
    ]);
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.kind === 'userTask' && task.assignee).toBe('demo');
    expect(task?.kind === 'userTask' && task.asyncBefore).toBe(true);

    // moddle cannot tie an undeclared operaton: element to a step, so the
    // attribute warning lands on the process rather than on the task that
    // carries it.
    expect(warnings.map((w) => [w.elementId, w.category])).toEqual([
      ['Lane_Ops', 'lane'],
      ['lanes-and-async', 'extensionAttribute'],
    ]);
    expectMentions(warnings.map((w) => w.message).join('\n'), [
      'operaton:properties',
    ]);
  });

  it('the conditional-start fixture is refused with UnsupportedEventDefinitionError naming the offending start event, with no BPMN jargon', async () => {
    const xml = fs.readFileSync(CONDITIONAL_START_BPMN, 'utf-8');

    await expect(xmlToIr(xml)).rejects.toBeInstanceOf(
      UnsupportedEventDefinitionError,
    );

    try {
      await xmlToIr(xml);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedConstructError);
      const e = err as UnsupportedEventDefinitionError;
      expect(e.elementId).toBe('ScheduledStart');
      expect(e.eventKind).toBe('start');
      expect(e.definitionType).toBe('bpmn:ConditionalEventDefinition');
      expect(e.message).toContain('ScheduledStart');
      expect(e.message.toLowerCase()).toContain('conditional');
      assertNoForbiddenJargon(e.message);
    }
  });
});

type ParseExpectation =
  | {
      /** Ran to the end: the ids of the warning lines, in the order printed. */
      exit?: undefined;
      warningIds: string[];
      mentions: string[];
      script: string[];
    }
  | { exit: number; mentions: string[] };

type ParseRow = readonly [
  title: string,
  fixture: string,
  expected: ParseExpectation,
];

describe('decompile contract: what `bpmns parse` does with the same fixtures', () => {
  test.each<ParseRow>([
    [
      'a dropped lane and a dropped engine attribute are printed as warnings, and the script is written anyway',
      LANES_AND_ASYNC_BPMN,
      {
        warningIds: ['Lane_Ops', 'lanes-and-async'],
        mentions: ['operaton:properties'],
        script: [
          'process lanes-and-async',
          'start ReviewStart',
          'user ReviewRequest',
          'assignee = "demo"',
          'end ReviewDone',
        ],
      },
    ],
    [
      'a refused construct exits 1, writes nothing, and says which element it was',
      CONDITIONAL_START_BPMN,
      // 1 means unsupported construct; 2 would mean I/O or generic failure.
      { exit: 1, mentions: ['ScheduledStart', 'conditional'] },
    ],
  ])('%s', async (_title, fixture, expected) => {
    const run = await runParse({ file: fixture });
    const stderr = run.stderr.join('\n');

    expect(run.exit).toBe(expected.exit);
    expectMentions(stderr, expected.mentions);

    if (expected.exit !== undefined) {
      // A refusal is the one message the author has to act on, so it stays in
      // the vocabulary the DSL uses.
      assertNoForbiddenJargon(stderr);
      expect(run.output).toBeUndefined();
      return;
    }

    expect(
      run.stderr.map((line) => /^Warning: ([^:]+): /.exec(line)?.[1]),
    ).toEqual(expected.warningIds);
    expectMentions(run.output ?? '', expected.script);
  });
});

describe('decompile contract: the script it hands back goes through the pipeline again', () => {
  it('the DSL produced from the lanes-and-async fixture re-parses with zero parser errors and zero validation diagnostics', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir } = await xmlToIr(xml);
    const dsl = irToDsl(ir).source;

    const document = await parse(dsl, { validation: true });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const { diagnostics } = await validate(dsl);
    expect(diagnostics).toHaveLength(0);
  });

  it('the DSL produced from a diagram whose labeled start and end carry generated-shaped ids re-parses with zero diagnostics, and each dropped label is warned about', async () => {
    const { ir, warnings } = await xmlToIr(GENERATED_ID_LABELS_BPMN);
    const dsl = irToDsl(ir).source;

    const document = await parse(dsl, { validation: true });
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const { diagnostics } = await validate(dsl);
    expect(diagnostics).toHaveLength(0);

    const labelWarnings = warnings.filter((w) => w.category === 'label');
    expect(labelWarnings.map((w) => w.elementId)).toEqual([
      'StartEvent_1',
      'EndEvent_1',
    ]);
    expect(labelWarnings[0]?.message).toContain('Order received');
    expect(labelWarnings[1]?.message).toContain('Order filed');
    for (const w of labelWarnings) assertNoForbiddenJargon(w.message);
  });

  it('the DSL produced from the lanes-and-async fixture builds again without validation errors, and the rebuilt BPMN re-imports cleanly', async () => {
    const xml = fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8');
    const { ir } = await xmlToIr(xml);

    const run = await runBuild({ text: irToDsl(ir).source });

    expect(run.exit).toBeUndefined();
    expect(run.stderr).toEqual([]);
    expect((await xmlToIr(run.output!)).ir.id).toBe('lanes-and-async');
  });
});

describe('decompile contract: language integrity', () => {
  it('a document tripping both an extra process and a goto into a parallel branch yields exactly those two errors, each an error severity, with jargon-free wording', async () => {
    const source = `
process Flow {
  parallel {
    { user A }
    { user B }
  }
  goto A
}
process Second {
  start S
  end E
}
`;

    const { document, diagnostics } = await validate(source);
    expect(document.parseResult.parserErrors).toHaveLength(0);

    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.severity).toBe(1);
      assertNoForbiddenJargon(diagnosticMessage(d));
    }

    const extraProcess = diagnostics.find((d) =>
      diagnosticMessage(d).includes('Only one process is supported'),
    );
    expect(extraProcess).toBeDefined();

    const gotoIntoParallel = diagnostics.find((d) =>
      diagnosticMessage(d).toLowerCase().includes('branch'),
    );
    expect(gotoIntoParallel && diagnosticMessage(gotoIntoParallel)).toContain(
      'A',
    );
  });
});
