// What `bpmns build` and `bpmns parse` make of a file: the exit code, what
// lands on stderr, and what is written. The decompile contract itself, and the
// fixtures that carry it, are in `decompile-contract.e2e.test.ts`.

import { describe, test, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
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
  runActionAt,
  runBuild,
  runParse,
  type Input,
} from './helpers/actions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Read from package.json rather than imported from util.ts: that export is
// what the exporterVersion assertion pins.
const PACKAGE_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(REPO_ROOT, 'packages/cli/package.json'),
      'utf-8',
    ),
  ) as { version: string }
).version;

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

// A back-edge into a parallel fork (`B -> Fork`), which the decompiler cannot
// phrase as a `goto`; only hand-built BPMN gets here.
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

// Two steps with one conditioned outgoing flow each, so both draw the same
// dropped-condition warning.
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

// A number field whose default the engine's `LongFormType` cannot convert:
// imported as written, refused by the validator.
const DECIMAL_DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://test">
  <bpmn:process id="decimal-default-carry" isExecutable="true">
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

type ParseExpectation = {
  /** The id of every `Warning: <id>: ...` line, in the order printed. */
  warningIds: string[];
  /** Substrings the warnings must carry; the wording is the transform's own. */
  mentions?: string[];
  script?: string[];
  /** Set where the warnings differ in nothing but the element they name. */
  sameMessage?: boolean;
  /** The re-validation lines after the warnings, whole; a RegExp where the line number is not pinned. */
  buildErrorLines?: (string | RegExp)[];
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
        script: ['CheckStock', 'ReserveGoods'],
      },
    ],
    [
      'a setting the import warning names as an eventual failure is confirmed, after that warning, by re-validating the printed script',
      { text: DECIMAL_DEFAULT_BPMN },
      {
        warningIds: ['Review'],
        mentions: ["default '1.5'", 'imported as written'],
        script: ['amount: number = 1.5'],
        buildErrorLines: [
          'Warning: the printed script draws 1 error(s) when built; hand-repair is needed:',
          /^ {2}line \d+: The default 1\.5 of number field 'amount' is not an integer; the engine converts it with Long\.valueOf every time the form renders \(LongFormType\.convertValue\) and throws on anything else\. \[.+\]$/,
        ],
      },
    ],
  ])('%s', async (_title, input, expected) => {
    const run = await runParse(input);

    expect(run.exit).toBeUndefined();
    expect(run.output).toBeDefined();

    const tailLen = expected.buildErrorLines?.length ?? 0;
    expect(run.stderr).toHaveLength(expected.warningIds.length + tailLen);
    const splitAt = run.stderr.length - tailLen;
    const idLines = run.stderr.slice(0, splitAt);
    const tail = run.stderr.slice(splitAt);

    const prefixes = idLines.map(
      (line) => /^Warning: ([^:]+): /.exec(line)?.[1],
    );
    expect(prefixes).toEqual(expected.warningIds);

    tail.forEach((line, i) => {
      const want = expected.buildErrorLines![i];
      if (want instanceof RegExp) expect(line).toMatch(want);
      else expect(line).toBe(want);
    });

    expectMentions(idLines.join('\n'), expected.mentions ?? []);
    expectMentions(run.output ?? '', expected.script ?? []);

    if (expected.sameMessage) {
      const bodies = idLines.map((line, i) =>
        line.slice(`Warning: ${expected.warningIds[i]}: `.length),
      );
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toBe('');
    }

    const document = await parse(run.output!);
    expect(document.parseResult.parserErrors).toHaveLength(0);
  });
});

// Uses `amount` without declaring it: severity 2.
const WARNING_ONLY_SOURCE = `process warning-only {
  start S
  if (amount > 1000) {
    service DoSomething(class: "com.example.Delegate")
  } else {
    end A
  }
  end Done
}
`;

// Yields zero Process nodes, as an empty file does.
const KEYWORD_TYPO_SOURCE = 'proces p { user A }\n';

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
  exit?: number;
  /** The process id the written BPMN imports back under, if one was written. */
  reimportsAs?: string;
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
    [
      'a keyword typo lists the parser error instead of the no-process message',
      { text: KEYWORD_TYPO_SOURCE },
      {
        exit: 1,
        stderrLines: 2,
        mentions: ['Validation errors:', 'proces'],
      },
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
    expect(run.output!.match(/exporterVersion="[^"]*"/g)).toEqual([
      `exporterVersion="${PACKAGE_VERSION}"`,
    ]);
  });
});

const VALID_DSL = 'process guard { start S end E }';

const VALID_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  targetNamespace="http://test">
  <bpmn:process id="guard" isExecutable="true">
    <bpmn:startEvent id="S" />
    <bpmn:endEvent id="E" />
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

// Over 40 characters, so the preview's cutoff shows.
const SWAPPED_DSL =
  'process invoice_approval { start S user Review(assignee: "demo") end E }';

// Over 40 characters of accented text, which the preview keeps.
const NON_ASCII_PREVIEW_SOURCE =
  'prüfen, ob Umlaute überleben und nicht nur ASCII-Zeichen übrig bleiben';

type GuardCase = {
  inputPath: string;
  opts: { output?: string; force?: boolean };
  exit: number | undefined;
  /** The first stderr line, where the row expects one. */
  line?: string;
  check?: () => void;
};

type GuardRow = readonly [
  title: string,
  action: 'build' | 'parse',
  make: (dir: string) => GuardCase,
];

// The path guards are one mechanism in `util.ts`, so each has a row per
// command to pin that both call it.
describe('bpmns build / bpmns parse: guards against destructive or unclear failures', () => {
  test.each<GuardRow>([
    [
      'build: an existing output is refused without --force, and is left untouched',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmnscript');
        fs.writeFileSync(inputPath, VALID_DSL, 'utf-8');
        const outputPath = path.join(dir, 'order.bpmn');
        fs.writeFileSync(outputPath, 'PRE-EXISTING', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line: `Error: ${outputPath} exists; pass --force to overwrite it or -o for another path`,
          check: () =>
            expect(fs.readFileSync(outputPath, 'utf-8')).toBe('PRE-EXISTING'),
        };
      },
    ],
    [
      'build: --force overwrites an existing output',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmnscript');
        fs.writeFileSync(inputPath, VALID_DSL, 'utf-8');
        const outputPath = path.join(dir, 'order.bpmn');
        fs.writeFileSync(outputPath, 'PRE-EXISTING', 'utf-8');
        return {
          inputPath,
          opts: { force: true },
          exit: undefined,
          check: () =>
            expect(fs.readFileSync(outputPath, 'utf-8')).toContain('<?xml'),
        };
      },
    ],
    [
      'build: an -o equal to the input path is refused, and the source is left untouched',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'same.bpmnscript');
        fs.writeFileSync(inputPath, VALID_DSL, 'utf-8');
        return {
          inputPath,
          opts: { output: inputPath },
          exit: 2,
          line: 'Error: the input and the output are the same file',
          check: () =>
            expect(fs.readFileSync(inputPath, 'utf-8')).toBe(VALID_DSL),
        };
      },
    ],
    [
      'build: a directory input is refused',
      'build',
      (dir) => ({
        inputPath: dir,
        opts: {},
        exit: 2,
        line: `Error: ${dir} is a directory`,
      }),
    ],
    [
      'build: an -o naming a directory writes inside it under the default basename',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmnscript');
        fs.writeFileSync(inputPath, VALID_DSL, 'utf-8');
        const outDir = path.join(dir, 'out');
        fs.mkdirSync(outDir);
        return {
          inputPath,
          opts: { output: outDir },
          exit: undefined,
          check: () =>
            expect(
              fs.readFileSync(path.join(outDir, 'order.bpmn'), 'utf-8'),
            ).toContain('<?xml'),
        };
      },
    ],
    [
      'build: a wrong extension is refused outright, not warned about then crashed on',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'order.txt');
        fs.writeFileSync(inputPath, VALID_DSL, 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            'Error: expected a file with one of these extensions: .bpmnscript; ' +
            'a .bpmn file is decompiled with `bpmns parse`',
        };
      },
    ],
    [
      'build: an empty source is reported plainly, without a pipeline stage name',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'empty.bpmnscript');
        fs.writeFileSync(inputPath, '   \n  \n', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 1,
          line: 'Error: the file has no process',
        };
      },
    ],
    [
      'build: a comment-only source is reported the same way, not as an astToIr internal error',
      'build',
      (dir) => {
        const inputPath = path.join(dir, 'comment-only.bpmnscript');
        fs.writeFileSync(inputPath, '// nothing but a comment here\n', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 1,
          line: 'Error: the file has no process',
        };
      },
    ],
    [
      'parse: an existing output is refused without --force, and is left untouched',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmn');
        fs.writeFileSync(inputPath, VALID_BPMN, 'utf-8');
        const outputPath = path.join(dir, 'order.bpmnscript');
        fs.writeFileSync(outputPath, 'PRE-EXISTING', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line: `Error: ${outputPath} exists; pass --force to overwrite it or -o for another path`,
          check: () =>
            expect(fs.readFileSync(outputPath, 'utf-8')).toBe('PRE-EXISTING'),
        };
      },
    ],
    [
      'parse: --force overwrites an existing output',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmn');
        fs.writeFileSync(inputPath, VALID_BPMN, 'utf-8');
        const outputPath = path.join(dir, 'order.bpmnscript');
        fs.writeFileSync(outputPath, 'PRE-EXISTING', 'utf-8');
        return {
          inputPath,
          opts: { force: true },
          exit: undefined,
          check: () =>
            expect(fs.readFileSync(outputPath, 'utf-8')).toContain(
              'process guard',
            ),
        };
      },
    ],
    [
      'parse: an -o equal to the input path is refused, and the source is left untouched',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'same.bpmn');
        fs.writeFileSync(inputPath, VALID_BPMN, 'utf-8');
        return {
          inputPath,
          opts: { output: inputPath },
          exit: 2,
          line: 'Error: the input and the output are the same file',
          check: () =>
            expect(fs.readFileSync(inputPath, 'utf-8')).toBe(VALID_BPMN),
        };
      },
    ],
    [
      'parse: a directory input is refused',
      'parse',
      (dir) => ({
        inputPath: dir,
        opts: {},
        exit: 2,
        line: `Error: ${dir} is a directory`,
      }),
    ],
    [
      'parse: an -o naming a directory writes inside it under the default basename',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'order.bpmn');
        fs.writeFileSync(inputPath, VALID_BPMN, 'utf-8');
        const outDir = path.join(dir, 'out');
        fs.mkdirSync(outDir);
        return {
          inputPath,
          opts: { output: outDir },
          exit: undefined,
          check: () =>
            expect(
              fs.readFileSync(path.join(outDir, 'order.bpmnscript'), 'utf-8'),
            ).toContain('process guard'),
        };
      },
    ],
    [
      'parse: an empty file is reported plainly, not as an XML parse failure',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'empty.bpmn');
        fs.writeFileSync(inputPath, '', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line: 'Error: the file is empty',
        };
      },
    ],
    [
      'parse: binary input is reported, not dumped onto stderr',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'binary.bpmn');
        const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]);
        fs.writeFileSync(inputPath, bytes);
        // 0xff/0xfe are not valid UTF-8 and decode to U+FFFD, which is not a
        // control character, so the preview keeps them.
        const preview = bytes.toString('utf-8').replace(/\p{C}/gu, '');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            `Error: not an XML document (starts with "${preview}"); ` +
            'a .bpmnscript file is built with `bpmns build`',
        };
      },
    ],
    [
      'parse: an accented preview keeps its own characters, only control bytes are stripped',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'umlaut.bpmn');
        fs.writeFileSync(inputPath, NON_ASCII_PREVIEW_SOURCE, 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            `Error: not an XML document (starts with "${NON_ASCII_PREVIEW_SOURCE.slice(0, 40)}"); ` +
            'a .bpmnscript file is built with `bpmns build`',
        };
      },
    ],
    [
      'parse: DSL text given by mistake is reported, not echoed back whole',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'swapped.bpmn');
        fs.writeFileSync(inputPath, SWAPPED_DSL, 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            `Error: not an XML document (starts with "${SWAPPED_DSL.slice(0, 40)}"); ` +
            'a .bpmnscript file is built with `bpmns build`',
        };
      },
    ],
    [
      'parse: a non-BPMN root names the tag and namespace it expected',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'not-definitions.bpmn');
        fs.writeFileSync(inputPath, '<html><body>hi</body></html>', 'utf-8');
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            `Error: failed to parse ${inputPath}: failed to parse document as <bpmn:Definitions> ` +
            '(root element is <html>; expected <bpmn:definitions> in namespace ' +
            'http://www.omg.org/spec/BPMN/20100524/MODEL)',
        };
      },
    ],
    [
      'parse: a wrong bpmn namespace names the namespace it found',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'wrong-ns.bpmn');
        fs.writeFileSync(
          inputPath,
          '<bpmn:definitions xmlns:bpmn="http://example.com/wrong" ' +
            'xmlns:operaton="http://operaton.org/schema/1.0/bpmn" id="d">' +
            '<bpmn:process id="p"/></bpmn:definitions>',
          'utf-8',
        );
        return {
          inputPath,
          opts: {},
          exit: 2,
          line:
            `Error: failed to parse ${inputPath}: failed to parse document as <bpmn:Definitions> ` +
            '(root element is <bpmn:definitions>; expected <bpmn:definitions> in namespace ' +
            'http://www.omg.org/spec/BPMN/20100524/MODEL; found xmlns:bpmn=http://example.com/wrong)',
        };
      },
    ],
    [
      'parse: an unclosed tag with no closing bracket anywhere is cut to its first line, capped at 200 characters, with any control byte stripped',
      'parse',
      (dir) => {
        const inputPath = path.join(dir, 'unclosed.bpmn');
        // `saxen` echoes the whole unparsed remainder, the NUL included, into
        // this one line, then appends `\n\tline: ...`, which the cutoff must
        // never reach.
        const unclosedTag = '<bad\0tag' + 'z'.repeat(300);
        fs.writeFileSync(inputPath, unclosedTag, 'utf-8');
        const rawFirstLine = `unparsable content ${unclosedTag} detected`;
        const capped = rawFirstLine.slice(0, 200) + '...';
        return {
          inputPath,
          opts: {},
          exit: 2,
          line: `Error: failed to parse ${inputPath}: ${capped.replace(/\p{C}/gu, '')}`,
        };
      },
    ],
  ])('%s', async (_title, action, make) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpmns-guard-'));
    try {
      const { inputPath, opts, exit, line, check } = make(dir);
      const run = await runActionAt(action, inputPath, opts);
      expect(run.exit).toBe(exit);
      if (line !== undefined) expect(run.stderr[0]).toBe(line);
      check?.();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tmLanguage extension sync', () => {
  test('the extension ships the current grammar', () => {
    expect(fs.readFileSync(EXTENSION_TMLANGUAGE, 'utf-8')).toBe(
      fs.readFileSync(LANGUAGE_TMLANGUAGE, 'utf-8'),
    );
  });
});
