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

import { runBuild, runParse } from './helpers/actions.js';

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
    expect(parsed).toEqual({
      exit: undefined,
      stderr: [
        "Warning: lane 'Operations' (Lane_Ops) was not imported\n" +
          '  note: every step is placed in a single flat process',
        "Warning: 'operaton:properties' on 'ReviewRequest' was not imported\n" +
          "  note: BPMNscript reads no such setting on a 'bpmn:userTask'\n" +
          '  note: the rebuilt document carries none',
      ],
      output: `process lanes-and-async {
  start ReviewStart
  user ReviewRequest(label: "Review request", assignee: "demo", asyncBefore: true)
  end ReviewDone
}
`,
    });
    const dsl = parsed.output!;

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
    expect(run).toEqual({
      exit: 1,
      stderr: [
        `Error: ${ERROR_START_BPMN}: element 'ShipmentFailed' cannot be imported: a process cannot start on an error\n` +
          '  note: Operaton ignores the trigger and starts the process as if none were written\n' +
          '  note: importing it would write back a document the engine runs differently from what it says\n' +
          "  help: catch it with 'on error' inside the scope that raises it",
      ],
      output: undefined,
    });
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
      `process generated-id-labels {
  start StartEvent_1(label: "Order received")
  user Approve
  end EndEvent_1(label: "Order filed")
}
`,
      [],
      [],
    ],
    [
      'the start id this tool generates for the process drops its statement and label, but a like-named end keeps both and is refused on the name alone',
      'StartEvent_generated-id-labels',
      'EndEvent_generated-id-labels',
      `process generated-id-labels {
  user Approve
  end EndEvent_generated-id-labels(label: "Order filed")
}
`,
      [
        "label 'Order received' on 'StartEvent_generated-id-labels' was not written to the script\n" +
          "note: 'StartEvent_generated-id-labels' is the kind of name BPMNscript generates for itself, which a script cannot repeat\n" +
          'note: this start is left out entirely, and its label with it\n' +
          'help: rename it in the diagram to keep the label',
      ],
      [
        "statement name 'EndEvent_generated-id-labels' is the id generated for the implicit end event of 'generated-id-labels'\n" +
          'help: choose another name',
      ],
    ],
  ])(
    'the DSL produced from a diagram where %s',
    async (_title, startId, endId, printed, labelWarnings, errors) => {
      const { ir, warnings } = await xmlToIr(
        labeledTerminalsBpmn(startId, endId),
      );
      const dsl = irToDsl(ir).source;
      expect(dsl).toBe(printed);
      expect(
        warnings.filter((w) => w.category === 'label').map((w) => w.message),
      ).toEqual(labelWarnings);

      const { document, diagnostics } = await validate(dsl);
      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(
        diagnostics.map((d) => [d.severity, Diagnostic.getMessageString(d)]),
      ).toEqual(errors.map((message) => [1, message]));
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
        'only one process is supported per file\n' +
          'help: move additional processes into separate files',
        intoBranchMessage('goto A', 'goto', 'parallel'),
      ].sort(),
    );
  });
});
