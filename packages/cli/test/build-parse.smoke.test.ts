// What `bpmns build` and `bpmns parse` make of a file: the exit code, what
// lands on stderr, and what is written. The decompile contract itself, and the
// fixtures that carry it, are in `decompile-contract.e2e.test.ts`.

import { describe, test, expect, beforeAll } from 'vitest';
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
  expectMentions,
  runBuild,
  runParse,
  type Input,
} from './helpers/actions.js';

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

const LANGUAGE_TMLANGUAGE = path.resolve(
  REPO_ROOT,
  'packages/language/syntaxes/bpmn-script.tmLanguage.json',
);

const EXTENSION_TMLANGUAGE = path.resolve(
  REPO_ROOT,
  'packages/extension/syntaxes/bpmn-script.tmLanguage.json',
);

let parse: ReturnType<typeof parseHelper<Model>>;

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
});

// Back-edge into a parallel fork (`B -> Fork`). The fork's out-edges are already
// consumed when the back-arrival is reached, so the decompiler emits the
// hand-repair marker instead of a `goto`. Only hand-built BPMN gets here.
const UNSTRUCTURED_FORK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="unstructured" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:parallelGateway id="Fork" />
    <bpmn:userTask id="A" name="A" />
    <bpmn:userTask id="B" name="B" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="Fork" />
    <bpmn:sequenceFlow id="F1" sourceRef="Fork" targetRef="A" />
    <bpmn:sequenceFlow id="F2" sourceRef="Fork" targetRef="B" />
    <bpmn:sequenceFlow id="F3" sourceRef="A" targetRef="E" />
    <bpmn:sequenceFlow id="F4" sourceRef="B" targetRef="Fork" />
  </bpmn:process>
</bpmn:definitions>`;

// Two steps, each with a single conditioned outgoing flow. Both produce the
// same dropped-condition text, so the element id is the only thing telling the
// reader which step lost a condition, and that two did.
const TWO_DROPPED_CONDITIONS_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  targetNamespace="http://test">
  <bpmn:process id="two-conditions" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="CheckStock" name="Check stock" />
    <bpmn:userTask id="ReserveGoods" name="Reserve goods" />
    <bpmn:userTask id="ShipOrder" name="Ship order" />
    <bpmn:endEvent id="Done" />
    <bpmn:sequenceFlow id="F0" sourceRef="Start" targetRef="CheckStock" />
    <bpmn:sequenceFlow id="F1" sourceRef="CheckStock" targetRef="ReserveGoods">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${inStock}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F2" sourceRef="ReserveGoods" targetRef="ShipOrder">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${paid}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="F3" sourceRef="ShipOrder" targetRef="Done" />
  </bpmn:process>
</bpmn:definitions>`;

type ParseExpectation = {
  /** The id of every `Warning: <id>: ...` line, in the order printed. */
  warningIds: string[];
  /** Substrings the warnings must carry; the wording is the transform's own. */
  mentions?: string[];
  /** Substrings the written script must carry. */
  script?: string[];
  /** Set where the warnings differ in nothing but the element they name. */
  sameMessage?: boolean;
};

type ParseRow = readonly [
  title: string,
  input: Input,
  expected: ParseExpectation,
];

describe('bpmns parse', () => {
  test.each<ParseRow>([
    [
      'a BPMN this tool generated decompiles with nothing to report',
      { file: GOLDEN_GENERATED_BPMN },
      { warningIds: [] },
    ],
    [
      'a region the decompiler cannot phrase is written with a hand-repair marker, and both warnings name the split it starts at',
      { text: UNSTRUCTURED_FORK_BPMN },
      {
        warningIds: ['Fork', 'Fork'],
        mentions: ['unstructured region', 'hand-repair'],
        script: ['// unstructured region: hand-repair required'],
      },
    ],
    [
      'two steps that lost the same thing are told apart by the id each line leads with',
      { text: TWO_DROPPED_CONDITIONS_BPMN },
      {
        warningIds: ['CheckStock', 'ReserveGoods'],
        sameMessage: true,
        // The id is worth printing because it is a token the reader can find
        // in the script they were just handed.
        script: ['CheckStock', 'ReserveGoods'],
      },
    ],
  ])('%s', async (_title, input, expected) => {
    const run = await runParse(input);

    expect(run.exit).toBeUndefined();
    expect(run.output).toBeDefined();

    const prefixes = run.stderr.map(
      (line) => /^Warning: ([^:]+): /.exec(line)?.[1],
    );
    expect(prefixes).toEqual(expected.warningIds);

    expectMentions(run.stderr.join('\n'), expected.mentions ?? []);
    expectMentions(run.output ?? '', expected.script ?? []);

    if (expected.sameMessage) {
      const bodies = run.stderr.map((line, i) =>
        line.slice(`Warning: ${expected.warningIds[i]}: `.length),
      );
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toBe('');
    }

    // Whatever it writes has to be a script the language accepts.
    const document = await parse(run.output!);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// Uses `amount` without declaring it: severity 2.
const WARNING_ONLY_SOURCE = `process warning-only {
  start S
  if (amount > 1000) {
    service DoSomething { class = "com.example.Delegate" }
  } else {
    end A
  }
  end Done
}
`;

// Declares `amount` as string, then compares it numerically: severity 1.
const TYPE_MISMATCH_SOURCE = `process type-mismatch {
  var amount: string
  start S
  if (amount > 1000) {
    end A
  } else {
    end B
  }
}
`;

type BuildExpectation = {
  /** The code it exited with, or undefined where it ran to the end. */
  exit?: number;
  /** The process id the written BPMN imports back under, if one was written. */
  reimportsAs?: string;
  /** How many lines reach stderr, and what they must say. */
  stderrLines: number;
  mentions?: string[];
};

type BuildRow = readonly [
  title: string,
  input: Input,
  expected: BuildExpectation,
];

describe('bpmns build', () => {
  test.each<BuildRow>([
    [
      'the invoice-approval example builds to BPMN that imports back under its own id',
      { file: INVOICE_APPROVAL_SRC },
      { reimportsAs: 'invoice-approval', stderrLines: 0 },
    ],
    [
      'an undeclared variable is only a warning, so the build still writes its output',
      { text: WARNING_ONLY_SOURCE },
      {
        reimportsAs: 'warning-only',
        stderrLines: 1,
        mentions: ['amount', 'not declared'],
      },
    ],
    [
      'a type mismatch fails the build with exit code 1 and writes nothing',
      { text: TYPE_MISMATCH_SOURCE },
      { exit: 1, stderrLines: 2, mentions: ['Validation errors:'] },
    ],
  ])('%s', async (_title, input, expected) => {
    const run = await runBuild(input);

    expect(run.exit).toBe(expected.exit);
    expect(run.stderr).toHaveLength(expected.stderrLines);
    expectMentions(run.stderr.join('\n'), expected.mentions ?? []);

    if (expected.reimportsAs === undefined) {
      expect(run.output).toBeUndefined();
      return;
    }
    expect(run.output).toBeDefined();
    expect((await xmlToIr(run.output!)).ir.id).toBe(expected.reimportsAs);
  });
});

describe('tmLanguage extension sync', () => {
  test('the extension ships the current grammar, copied by a build step', () => {
    expect(fs.readFileSync(EXTENSION_TMLANGUAGE, 'utf-8')).toBe(
      fs.readFileSync(LANGUAGE_TMLANGUAGE, 'utf-8'),
    );

    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(REPO_ROOT, 'packages/extension/package.json'),
        'utf-8',
      ),
    ) as { scripts?: Record<string, string> };

    const prepare = pkg.scripts?.['build:prepare'] ?? '';
    expect(prepare).toContain('language/syntaxes');
    expect(prepare).toContain('syntaxes');
    expect(prepare, 'build:prepare must perform a file copy').toMatch(/\bcp\b/);
  });
});
