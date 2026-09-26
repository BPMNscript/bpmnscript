import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import {
  createBpmnScriptServices,
  Diagnostic,
  intoBranchMessage,
  type Model,
} from '@bpmn-script/language';
import {
  xmlToIr,
  irToDsl,
  UnsupportedEventFeatureError,
} from '@bpmn-script/transform';

import { runBuild, runParse, expectMentions } from './helpers/actions.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const LANES_AND_ASYNC_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/lanes-and-async.bpmn',
);

const ERROR_START_BPMN = path.resolve(
  REPO_ROOT,
  'tests/fixtures/error-start.bpmn',
);

const labeledTerminalsBpmn = (
  startId: string,
  endId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test">
  <bpmn:process id="generated-id-labels" isExecutable="true">
    <bpmn:startEvent id="${startId}" name="Order received" />
    <bpmn:userTask id="Approve" />
    <bpmn:endEvent id="${endId}" name="Order filed" />
    <bpmn:sequenceFlow id="F1" sourceRef="${startId}" targetRef="Approve" />
    <bpmn:sequenceFlow id="F2" sourceRef="Approve" targetRef="${endId}" />
  </bpmn:process>
</bpmn:definitions>
`;

// BPMN vocabulary the DSL author never sees.
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

let validate: ReturnType<typeof validationHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  validate = validationHelper<Model>(services.BpmnScript);
});

describe('decompile contract on the fixtures', () => {
  it('the lanes-and-async fixture imports into the supported subset, warns once per dropped item, and its script builds and re-imports cleanly', async () => {
    const { ir, warnings } = await xmlToIr(
      fs.readFileSync(LANES_AND_ASYNC_BPMN, 'utf-8'),
    );
    expect(ir.flowElements.map((fe) => fe.kind)).toEqual([
      'startEvent',
      'userTask',
      'endEvent',
    ]);
    const task = ir.flowElements.find((fe) => fe.kind === 'userTask');
    expect(task?.kind === 'userTask' && task.assignee).toBe('demo');
    expect(task?.kind === 'userTask' && task.asyncBefore).toBe(true);
    // operaton:properties is a declared type, so moddle ties the drop to the
    // task that carries it rather than to the process.
    expect(warnings.map((w) => [w.elementId, w.category])).toEqual([
      ['Lane_Ops', 'lane'],
      ['ReviewRequest', 'extensionAttribute'],
    ]);

    const parsed = await runParse({ file: LANES_AND_ASYNC_BPMN });
    expect(parsed.exit).toBeUndefined();
    expect(
      parsed.stderr.map((line) => /^Warning: ([^:]+): /.exec(line)?.[1]),
    ).toEqual(['Lane_Ops', 'ReviewRequest']);
    expectMentions(parsed.stderr.join('\n'), ['operaton:properties']);
    const dsl = parsed.output!;
    expectMentions(dsl, [
      'process lanes-and-async',
      'start ReviewStart',
      'user ReviewRequest',
      'assignee: "demo"',
      'end ReviewDone',
    ]);

    const { document, diagnostics } = await validate(dsl);
    expect(document.parseResult.parserErrors).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);

    const built = await runBuild({ text: dsl });
    expect(built.exit).toBeUndefined();
    expect(built.stderr).toEqual([]);
    expect((await xmlToIr(built.output!)).ir.id).toBe('lanes-and-async');
  });

  it('the error-start fixture is refused, by the import and by `bpmns parse` with exit 1 and nothing written, naming the start event without BPMN jargon', async () => {
    const err: unknown = await xmlToIr(
      fs.readFileSync(ERROR_START_BPMN, 'utf-8'),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedEventFeatureError);
    expect((err as UnsupportedEventFeatureError).elementId).toBe(
      'ShipmentFailed',
    );

    // 1 means unsupported construct; 2 would mean I/O or generic failure.
    const run = await runParse({ file: ERROR_START_BPMN });
    expect(run.exit).toBe(1);
    expect(run.output).toBeUndefined();
    const stderr = run.stderr.join('\n');
    expectMentions(stderr, ['ShipmentFailed', "Catch it with 'on error'"]);
    assertNoForbiddenJargon(stderr);
  });
});

describe('decompile contract: the script it hands back goes through the pipeline again', () => {
  // Only the ids the compiler generates are left out; a modeller's defaults
  // are names like any other. A generated-id start drops its label with an
  // import warning, a generated-id end prints and is refused on the name.
  it.each([
    [
      "a modelling tool's default ids keep their statements and labels",
      'StartEvent_1',
      'EndEvent_1',
      [
        'start StartEvent_1(label: "Order received")',
        'end EndEvent_1(label: "Order filed")',
      ],
      [],
      0,
    ],
    [
      'the start id this tool generates for the process drops its statement and label, but a like-named end keeps both and is refused on the name alone',
      'StartEvent_generated-id-labels',
      'EndEvent_generated-id-labels',
      ['end EndEvent_generated-id-labels(label: "Order filed")'],
      ['StartEvent_generated-id-labels'],
      1,
    ],
  ])(
    'the DSL produced from a diagram where %s',
    async (
      _title,
      startId,
      endId,
      printedLines,
      warnedIds,
      diagnosticCount,
    ) => {
      const { ir, warnings } = await xmlToIr(
        labeledTerminalsBpmn(startId, endId),
      );
      const dsl = irToDsl(ir).source;

      const { document, diagnostics } = await validate(dsl);
      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(diagnostics).toHaveLength(diagnosticCount);
      expect(
        dsl.split('\n').filter((line) => /^\s+(start|end) /.test(line)),
      ).toEqual(printedLines.map((line) => `  ${line}`));

      const labelWarnings = warnings.filter((w) => w.category === 'label');
      expect(labelWarnings.map((w) => w.elementId)).toEqual(warnedIds);
      for (const w of labelWarnings) {
        expect(w.message).toContain(
          w.elementId === startId ? 'Order received' : 'Order filed',
        );
        assertNoForbiddenJargon(w.message);
      }
    },
  );
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

    for (const d of diagnostics) {
      expect(d.severity).toBe(1);
      assertNoForbiddenJargon(Diagnostic.getMessageString(d));
    }
    expect(
      diagnostics.map((d) => Diagnostic.getMessageString(d)).sort(),
    ).toEqual(
      [
        'Only one process is supported per file. Move additional processes into separate files.',
        intoBranchMessage('goto A', 'goto', 'parallel'),
      ].sort(),
    );
  });
});
