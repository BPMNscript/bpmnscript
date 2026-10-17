// Documentation inside a condition, a time, a repetition count, a completion
// condition or the variable a repetition names: each prints, compiles back
// into the same child element, and survives an import of that XML.

import { it, expect } from 'vitest';

import { astToIr, irToXml, xmlToIr } from '@bpmn-script/transform';

import { compareModels } from './helpers/model-equivalence.js';
import {
  parseToAst,
  printDsl,
  roundTrip,
  validationErrors,
} from './helpers/pipeline.js';

const TEXT = 'Ask "${approver}" first.\nThen wait.';
const QUOTED = '"Ask \\"${approver}\\" first.\\nThen wait."';

const processOf = (statements: string[]): string =>
  [
    'process p {',
    '  var amount: number',
    '  var done: boolean',
    '  var lines: json',
    ...statements.map((line) => `  ${line}`),
    '}',
    '',
  ].join('\n');

/** Each documentation child with the element that holds it. */
function documentedTags(xml: string): [tag: string, text: string][] {
  return [
    ...xml.matchAll(
      /<bpmn:(\w+)[^<]*>\s*<bpmn:documentation>([^<]*)<\/bpmn:documentation>/g,
    ),
  ].map((m) => [m[1]!, m[2]!.replace(/&#10;/g, '\n').replace(/&#34;/g, '"')]);
}

const documentedLines = (dsl: string): string[] =>
  dsl
    .split('\n')
    .filter((line) => line.includes('ocumentation:'))
    .map((line) => line.trim());

async function reimported(xml: string) {
  const { ir, warnings } = await xmlToIr(xml);
  const dsl = printDsl(ir);
  const rebuilt = await xmlToIr(await irToXml(astToIr(await parseToAst(dsl))));
  return { ir, warnings, dsl, rebuilt: rebuilt.ir };
}

it.each([
  [
    'an if condition',
    [
      `if (amount > 1000, conditionDocumentation: ${QUOTED}) {`,
      '  step A',
      '} else {',
      '  step B',
      '}',
    ],
    'conditionExpression',
  ],
  [
    'an else-if condition',
    [
      'if (amount > 1000) {',
      '  step A',
      `} else if (amount > 10, conditionDocumentation: ${QUOTED}) {`,
      '  step B',
      '} else {',
      '  step C',
      '}',
    ],
    'conditionExpression',
  ],
  [
    'a while condition',
    [
      `while (amount < 3, conditionDocumentation: ${QUOTED}) {`,
      '  step W',
      '}',
    ],
    'conditionExpression',
  ],
  [
    'a do-while condition',
    [
      'do {',
      '  step W',
      `} while (amount < 3, conditionDocumentation: ${QUOTED})`,
    ],
    'conditionExpression',
  ],
  [
    'a parallel branch condition',
    [
      'parallel {',
      `  if (amount > 1, conditionDocumentation: ${QUOTED}) {`,
      '    step P1',
      '  }',
      '  else {',
      '    step P2',
      '  }',
      '}',
    ],
    'conditionExpression',
  ],
  [
    'an awaited duration',
    [`await timer("PT1H", timerDocumentation: ${QUOTED})`],
    'timeDuration',
  ],
  [
    'a start date',
    [`start S timer(at: "2099-01-01T00:00:00", timerDocumentation: ${QUOTED})`],
    'timeDate',
  ],
  [
    'an awaited condition',
    [`await condition(amount > 100, conditionDocumentation: ${QUOTED})`],
    'condition',
  ],
  [
    'a boundary timer',
    [
      'user R',
      `on R: timer("PT1H", timerDocumentation: ${QUOTED}) {`,
      '  step Late',
      '}',
    ],
    'timeDuration',
  ],
  [
    'a timeout listener',
    [
      'user R {',
      `  on timeout every "R/PT8H"(class: "a.B", timerDocumentation: ${QUOTED})`,
      '}',
    ],
    'timeCycle',
  ],
  [
    'a scripted timeout listener',
    [
      'user R {',
      `  on timeout after "PT8H"(timerDocumentation: ${QUOTED}) \`\`\`groovy`,
      '    escalate()',
      '  ```',
      '}',
    ],
    'timeDuration',
  ],
  [
    'a repetition count',
    [`user R for 3(countDocumentation: ${QUOTED})`],
    'loopCardinality',
  ],
  [
    'a repetition variable',
    [`user R for each line in lines(eachDocumentation: ${QUOTED})`],
    'inputDataItem',
  ],
  [
    'a completion condition',
    [`user R for 3 until (done, conditionDocumentation: ${QUOTED})`],
    'completionCondition',
  ],
])(
  'documentation on %s prints back where it was written, lands inside its element, and imports back with no difference',
  async (_title, statements, tag) => {
    const source = processOf(statements);
    expect(await validationErrors(source)).toEqual([]);
    const run = await roundTrip(source);
    expect(documentedTags(run.xml)).toEqual([[tag, TEXT]]);
    expect(documentedLines(run.dsl)).toEqual(documentedLines(source));

    const { ir, warnings, dsl, rebuilt } = await reimported(run.xml);
    expect(warnings).toEqual([]);
    expect(await validationErrors(dsl)).toEqual([]);
    expect(compareModels(ir, rebuilt).differences).toEqual([]);
  },
);

const IF_SOURCE = processOf([
  `if (amount > 1000, conditionDocumentation: ${QUOTED}) {`,
  '  step A',
  '}',
]);

it('keeps the documentation apart from the text of a condition moddle drops for its unprefixed type', async () => {
  const { xml } = await roundTrip(IF_SOURCE);
  const unprefixed = xml.replace(
    'xsi:type="bpmn:tFormalExpression"',
    'xsi:type="tFormalExpression"',
  );
  expect(unprefixed).not.toBe(xml);
  const { ir } = await xmlToIr(unprefixed);
  expect(
    ir.sequenceFlows
      .filter((flow) => flow.conditionExpression !== undefined)
      .map((flow) => [flow.conditionExpression, flow.conditionDocumentation]),
  ).toEqual([['${amount > 1000}', TEXT]]);
});

it('reports the documentation of a repetition variable with no name instead of dropping it', async () => {
  const { xml } = await roundTrip(
    processOf([`user R for each line in lines(eachDocumentation: ${QUOTED})`]),
  );
  const unnamed = xml.replace(
    '<bpmn:inputDataItem name="line">',
    '<bpmn:inputDataItem>',
  );
  expect(unnamed).not.toBe(xml);
  const { ir, warnings } = await xmlToIr(unnamed);
  expect(
    ir.flowElements.flatMap((el) => ('loop' in el ? [el.loop] : [])),
  ).toEqual([{ collection: 'lines' }]);
  expect(warnings).toEqual([
    {
      elementId: 'R',
      category: 'documentation',
      message:
        "documentation on 'R' was not imported\n" +
        "note: a 'bpmn:inputDataItem' without a name has no documentation in BPMNscript",
    },
  ]);
});

it.each([
  [
    "the element's documentation key beside a condition",
    ['if (amount > 1, documentation: "x") {', '  step A', '}'],
    [
      "'documentation' cannot document a condition\nhelp: write 'conditionDocumentation'",
    ],
  ],
  [
    'a setting other than conditionDocumentation beside a condition',
    ['if (amount > 1, label: "x") {', '  step A', '}'],
    [
      "only 'conditionDocumentation' can follow a condition inside its parentheses",
    ],
  ],
  [
    'a bare value beside a completion condition',
    ['user R for 3 until (done, "x")'],
    [
      "only 'conditionDocumentation' can follow a condition inside its parentheses",
    ],
  ],
  [
    'two documentations beside one condition',
    [
      'while (amount < 3, conditionDocumentation: "a", conditionDocumentation: "b") {',
      '  step W',
      '}',
    ],
    ["duplicate setting 'conditionDocumentation'"],
  ],
  [
    'a count documentation with no count',
    ['user R for each line in lines(countDocumentation: "x")'],
    [
      "setting 'countDocumentation' documents a count, but the 'for' clause has none",
    ],
  ],
  [
    'an each documentation with no variable',
    ['user R for each in lines(eachDocumentation: "x")'],
    [
      "setting 'eachDocumentation' documents the name after 'each', but the 'for' clause has none",
    ],
  ],
  [
    'a timer documentation on a condition',
    ['await condition(amount > 1, timerDocumentation: "x")'],
    ["setting 'timerDocumentation' is not valid on an awaited event"],
  ],
  [
    'a timer documentation on a listener without a timer',
    ['user R {', '  on create(class: "a.B", timerDocumentation: "x")', '}'],
    ["setting 'timerDocumentation' is not valid on a listener"],
  ],
])('refuses %s', async (_title, statements, errors) => {
  expect(await validationErrors(processOf(statements))).toEqual(errors);
});
