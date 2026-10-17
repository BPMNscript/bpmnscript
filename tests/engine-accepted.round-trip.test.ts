// Shapes the engine deploys and runs whose print the validator once refused,
// each cut down from a model in Operaton's own test suite.

import { it, expect } from 'vitest';

import { irToDsl, xmlToIr } from '@bpmn-script/transform';

import { bpmnDoc } from './helpers/bpmn-doc.js';
import { compareModels } from './helpers/model-equivalence.js';
import type { ModelReport } from './helpers/model-equivalence.js';
import { printDsl, roundTrip, validationErrors } from './helpers/pipeline.js';

/** `T` between a start `S` and an end `E`, under the flow ids a compile mints. */
const between = (step: string): string =>
  [
    '<bpmn:startEvent id="S" />',
    step,
    '<bpmn:endEvent id="E" />',
    '<bpmn:sequenceFlow id="Flow_S_T" sourceRef="S" targetRef="T" />',
    '<bpmn:sequenceFlow id="Flow_T_E" sourceRef="T" targetRef="E" />',
  ].join('\n');

const printedBetween = (step: string): string =>
  `process p {\n  start S\n  ${step}\n  end E\n}\n`;

// The fourth column is what the rebuild compares as against the import, with
// the normalizations that explain any difference ('same' if absent).
const flows = (pairs: string): string =>
  pairs
    .split(' ')
    .map((pair) => pair.split('>'))
    .map(
      ([from, to]) =>
        `<bpmn:sequenceFlow id="Flow_${from}_${to}" sourceRef="${from}" targetRef="${to}" />`,
    )
    .join('\n');

const conditioned = (from: string, to: string, body: string): string =>
  `<bpmn:sequenceFlow id="Flow_${from}_${to}" sourceRef="${from}" targetRef="${to}"><bpmn:conditionExpression>${body}</bpmn:conditionExpression></bpmn:sequenceFlow>`;

const STEP_FORK = 'Gateway_parallelGateway_[in:T]_[out:A,B]';

const ROWS: [
  title: string,
  body: string,
  printed: string,
  comparison?: Omit<ModelReport, 'differences'>,
][] = [
  [
    "a service task whose 'expression' is constant text prints it quoted",
    between('<bpmn:serviceTask id="T" operaton:expression="{true}" />'),
    printedBetween('service T(expression: "{true}")'),
  ],
  [
    'a script task with an empty body prints an empty fence',
    between(
      '<bpmn:scriptTask id="T" scriptFormat="groovy"><bpmn:script></bpmn:script></bpmn:scriptTask>',
    ),
    printedBetween('script T ```groovy\n```'),
  ],
  [
    'a repetition count computed in JUEL prints as arithmetic',
    between(
      '<bpmn:userTask id="T"><bpmn:multiInstanceLoopCharacteristics>' +
        '<bpmn:loopCardinality>${5-2}</bpmn:loopCardinality>' +
        '</bpmn:multiInstanceLoopCharacteristics></bpmn:userTask>',
    ),
    printedBetween('user T for 5 - 2'),
    {
      level: 'canonical',
      normalizations: [
        { names: ['expression-parse-trees'], elements: ['p/T'] },
      ],
    },
  ],
  [
    'a repetition count written as text around a template prints quoted',
    between(
      '<bpmn:userTask id="T"><bpmn:multiInstanceLoopCharacteristics>' +
        '<bpmn:loopCardinality>1${x}</bpmn:loopCardinality>' +
        '</bpmn:multiInstanceLoopCharacteristics></bpmn:userTask>',
    ),
    printedBetween('user T for "1${x}"'),
  ],
  [
    'a decision version written as text around a template prints quoted',
    between(
      '<bpmn:businessRuleTask id="T" operaton:decisionRef="d" ' +
        'operaton:decisionRefBinding="version" operaton:decisionRefVersion="0${v}" />',
    ),
    printedBetween('decide T(decision: "d", version: "0${v}")'),
  ],
  [
    'a form field property keyed by a keyword prints the key in backticks',
    between(
      '<bpmn:userTask id="T"><bpmn:extensionElements><operaton:formData>' +
        '<operaton:formField id="f" type="string"><operaton:properties>' +
        '<operaton:property id="true" value="yes" />' +
        '</operaton:properties></operaton:formField>' +
        '</operaton:formData></bpmn:extensionElements></bpmn:userTask>',
    ),
    printedBetween(
      'user T {\n    form {\n      f: string {\n        property `true` = "yes"\n      }\n    }\n  }',
    ),
  ],
  [
    'an injected field named by a keyword prints the name in backticks',
    between(
      '<bpmn:serviceTask id="T" operaton:class="a.B"><bpmn:extensionElements>' +
        '<operaton:field name="true" stringValue="x" />' +
        '</bpmn:extensionElements></bpmn:serviceTask>',
    ),
    printedBetween('service T(class: "a.B") {\n    field `true` = "x"\n  }'),
  ],
  [
    'two routes from a fork into one end event print as jumps to it after the block',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:parallelGateway id="F" />',
      '<bpmn:userTask id="A" />',
      '<bpmn:userTask id="B" />',
      '<bpmn:endEvent id="E" />',
      flows('S>F F>A F>B A>E B>E'),
    ].join('\n'),
    `process p {
  start S
  parallel {
    {
      user A
      goto E
    }
    {
      user B
      goto E
    }
  }
  end E
}
`,
    {
      level: 'same',
      normalizations: [
        {
          names: ['synthesized-ids'],
          elements: [
            'p/Flow_F_A',
            'p/Flow_F_B',
            'p/Flow_Gateway_p_1_fork_A',
            'p/Flow_Gateway_p_1_fork_B',
          ],
        },
        { names: ['element-order'], elements: ['p'] },
      ],
    },
  ],
  [
    'two routes from a step into one end event print as jumps to it after the block',
    [
      '<bpmn:startEvent id="S" />',
      ...['T', 'A', 'B'].map((id) => `<bpmn:userTask id="${id}" />`),
      '<bpmn:endEvent id="E" />',
      flows('S>T T>A T>B A>E B>E'),
    ].join('\n'),
    `process p {
  start S
  user T
  parallel {
    {
      user A
      goto E
    }
    {
      user B
      goto E
    }
  }
  end E
}
`,
    {
      level: 'same',
      normalizations: [
        {
          names: ['synthesized-ids'],
          elements: [
            'p/Flow_Gateway_p_2_fork_A',
            'p/Flow_Gateway_p_2_fork_B',
            'p/Flow_T_A',
            'p/Flow_T_B',
          ],
        },
        { names: ['element-order'], elements: ['p'] },
        {
          names: ['uncontrolled-flow'],
          elements: [
            `p/Flow_${STEP_FORK}_A`,
            `p/Flow_${STEP_FORK}_B`,
            'p/Flow_T_A',
            'p/Flow_T_B',
            `p/Flow_T_${STEP_FORK}`,
            `p/${STEP_FORK}`,
          ],
        },
      ],
    },
  ],
];

it.each(ROWS)('%s', async (_title, body, printed, comparison) => {
  const { ir } = await xmlToIr(bpmnDoc(body));
  const dsl = printDsl(ir);
  expect(dsl).toBe(printed);
  expect(await validationErrors(dsl)).toEqual([]);
  const { ir2: rebuilt } = await roundTrip(dsl);
  expect(compareModels(ir, rebuilt)).toEqual({
    level: 'same',
    normalizations: [],
    ...comparison,
    differences: [],
  });
});

/** `A`/`B` and `C`/`D` each meet at a join of their own before `J3`. */
const nestedJoins = (kind: string): string =>
  [
    '<bpmn:startEvent id="S" />',
    `<bpmn:${kind} id="F" />`,
    ...['A', 'B', 'C', 'D', 'T'].map((id) => `<bpmn:userTask id="${id}" />`),
    ...['J1', 'J2', 'J3'].map((id) => `<bpmn:${kind} id="${id}" />`),
    '<bpmn:endEvent id="E" />',
    flows('S>F F>A F>B F>C F>D A>J1 B>J1 C>J2 D>J2 J1>J3 J2>J3 J3>T T>E'),
  ].join('\n');

// A gateway's key in a difference, by the routes in and out of it.
const parallel = (ins: string, outs: string): string =>
  `Gateway_parallelGateway_[in:${ins}]_[out:${outs}]`;
const inclusive = (ins: string, outs: string): string =>
  `Gateway_inclusiveGateway_[in:${ins}]_[out:${outs}]`;
const INC = 'gateway:inclusiveGateway';
const IN_AB = inclusive('A,B', INC);
const IN_CD = inclusive('C,D', INC);
const IN_OUTER = inclusive(`${INC},${INC}`, 'T');
const PAR_AB = parallel('A,B', 'T');
const AB_TO_END = parallel('A,B', 'endEvent:');
const INC_TO_E = inclusive('A,B', 'E');
const PAR_TO_E = parallel('A,B', 'E');

// Shapes the script cannot hold, printed valid with a warning naming each
// element whose loss the remaining differences show. A difference is the side
// holding the element ('a' the import, 'b' the rebuild) and its key.
it.each<
  [
    title: string,
    body: string,
    printed: string,
    warnings: [category: string, elementId: string][],
    differences: string[],
  ]
>([
  [
    'a step nothing leads to is left out',
    between('<bpmn:userTask id="T" />\n<bpmn:userTask id="O" />'),
    printedBetween('user T'),
    [['unreachable', 'O']],
    ['a O'],
  ],
  [
    'routes out of a sub-process that stop without an end event are joined',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:subProcess id="P"><bpmn:startEvent id="PS" /><bpmn:endEvent id="PE" />',
      '<bpmn:sequenceFlow id="Flow_PS_PE" sourceRef="PS" targetRef="PE" /></bpmn:subProcess>',
      '<bpmn:userTask id="A" />',
      '<bpmn:userTask id="B" />',
      flows('S>P P>A P>B'),
    ].join('\n'),
    `process p {
  start S
  subprocess P {
    start PS
    end PE
  }
  parallel {
    {
      user A
    }
    {
      user B
    }
  }
}
`,
    [['addedJoin', 'P']],
    [
      'b endEvent:',
      `b ${AB_TO_END}`,
      `b Flow_A_${AB_TO_END}`,
      `b Flow_B_${AB_TO_END}`,
      `b Flow_${AB_TO_END}_endEvent:`,
    ],
  ],
  [
    'one route that stops without an end event beside one that ends gains an end event and no join',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:parallelGateway id="F" />',
      '<bpmn:userTask id="A" />',
      '<bpmn:userTask id="B" />',
      '<bpmn:endEvent id="E" />',
      flows('S>F F>A F>B B>E'),
    ].join('\n'),
    `process p {
  start S
  parallel {
    {
      user A
    }
    {
      user B
      end E
    }
  }
}
`,
    [],
    [],
  ],
  [
    'conditioned routes from an inclusive fork into one end event print as jumps to it after the block',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:inclusiveGateway id="F" />',
      '<bpmn:userTask id="A" />',
      '<bpmn:userTask id="B" />',
      '<bpmn:endEvent id="E" />',
      flows('S>F A>E B>E'),
      conditioned('F', 'A', '${x == 1}'),
      conditioned('F', 'B', '${x &lt;= 2}'),
    ].join('\n'),
    `process p {
  var x: any
  start S
  parallel {
    if (x == 1) {
      user A
      goto E
    }
    if (x <= 2) {
      user B
      goto E
    }
    else fail
  }
  end E
}
`,
    [],
    [],
  ],
  [
    'an inclusive fork and join weighing no branch print as a parallel block, warned at the join',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:inclusiveGateway id="F" />',
      '<bpmn:userTask id="A" />',
      '<bpmn:userTask id="B" />',
      '<bpmn:inclusiveGateway id="J" />',
      '<bpmn:endEvent id="E" />',
      flows('S>F F>A F>B A>J B>J J>E'),
    ].join('\n'),
    `process p {
  start S
  parallel {
    {
      user A
    }
    {
      user B
    }
  }
  end E
}
`,
    [['changedJoin', 'J']],
    [INC_TO_E, PAR_TO_E].flatMap((g, i) =>
      [g, `Flow_A_${g}`, `Flow_B_${g}`, `Flow_${g}_E`].map(
        (key) => `${'ab'[i]} ${key}`,
      ),
    ),
  ],
  [
    'joins nested under one fork print as nested parallel blocks',
    nestedJoins('parallelGateway'),
    `process p {
  start S
  parallel {
    {
      parallel {
        {
          user A
        }
        {
          user B
        }
      }
    }
    {
      parallel {
        {
          user C
        }
        {
          user D
        }
      }
    }
  }
  user T
  end E
}
`,
    [['nestedFork', 'F']],
    [],
  ],
  [
    'a join inside a join nests one block deeper',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:parallelGateway id="F" />',
      ...['A1', 'A2', 'B', 'C', 'D'].map(
        (id) => `<bpmn:userTask id="${id}" />`,
      ),
      ...['J0', 'J1', 'J2', 'J3'].map(
        (id) => `<bpmn:parallelGateway id="${id}" />`,
      ),
      '<bpmn:endEvent id="E" />',
      flows(
        'S>F F>A1 F>A2 F>B F>C F>D A1>J0 A2>J0 J0>J1 B>J1 C>J2 D>J2 J1>J3 J2>J3 J3>E',
      ),
    ].join('\n'),
    `process p {
  start S
  parallel {
    {
      parallel {
        {
          parallel {
            {
              user A1
            }
            {
              user A2
            }
          }
        }
        {
          user B
        }
      }
    }
    {
      parallel {
        {
          user C
        }
        {
          user D
        }
      }
    }
  }
  end E
}
`,
    [['nestedFork', 'F']],
    [],
  ],
  [
    'inclusive joins nested under one fork leave as jumps past them',
    nestedJoins('inclusiveGateway'),
    `process p {
  start S
  parallel {
    {
      user A
    }
    {
      user B
    }
    {
      user C
      goto T
    }
    {
      user D
      goto T
    }
  }
  user T
  end E
}
`,
    [
      ['changedJoin', 'J1'],
      ['skippedJoin', 'J2'],
      ['skippedJoin', 'J3'],
    ],
    [
      ...[IN_AB, IN_CD, IN_OUTER].map((g) => `a ${g}`),
      ...['A', 'B'].map((id) => `a Flow_${id}_${IN_AB}`),
      ...['C', 'D'].map((id) => `a Flow_${id}_${IN_CD}`),
      `a Flow_${IN_AB}_${IN_OUTER}`,
      `a Flow_${IN_CD}_${IN_OUTER}`,
      `a Flow_${IN_OUTER}_T`,
      `b ${PAR_AB}`,
      `b Flow_A_${PAR_AB}`,
      `b Flow_B_${PAR_AB}`,
      'b Flow_C_T',
      'b Flow_D_T',
      `b Flow_${PAR_AB}_T`,
    ],
  ],
])('%s', async (_title, body, source, warnings, differences) => {
  const { ir } = await xmlToIr(bpmnDoc(body));
  const printed = irToDsl(ir);
  expect(printed.source).toBe(source);
  expect(printed.warnings.map((w) => [w.category, w.elementId])).toEqual(
    warnings,
  );
  expect(await validationErrors(printed.source)).toEqual([]);
  const { ir2: rebuilt } = await roundTrip(printed.source);
  const report = compareModels(ir, rebuilt);
  expect(report.differences.map((d) => `${d.only} ${d.element}`)).toEqual(
    differences,
  );
});

// Prints the rebuild holds differently but Operaton runs the same, which
// compare equal only through the normalization each row names.
it.each<[title: string, body: string, normalizations: string[][]]>([
  [
    'an unconditioned last route of an exclusive gateway comes back as its default through unconditioned-last-route',
    [
      '<bpmn:startEvent id="S" />',
      '<bpmn:exclusiveGateway id="G" />',
      ...['A', 'B'].map((id) => `<bpmn:userTask id="${id}" />`),
      ...['EA', 'EB'].map((id) => `<bpmn:endEvent id="${id}" />`),
      flows('S>G'),
      conditioned('G', 'A', '${x &gt; 1}'),
      flows('G>B A>EA B>EB'),
    ].join('\n'),
    [
      ['synthesized-ids'],
      ['pass-through-gateways'],
      ['element-order'],
      ['unconditioned-last-route'],
    ],
  ],
  [
    'joins nested under one fork come back with a fork ahead of each join through nested-forks',
    nestedJoins('parallelGateway'),
    [['synthesized-ids'], ['element-order'], ['nested-forks']],
  ],
])('%s', async (_title, body, normalizations) => {
  const { ir } = await xmlToIr(bpmnDoc(body));
  const { ir2: rebuilt } = await roundTrip(printDsl(ir));
  const report = compareModels(ir, rebuilt);
  expect({
    level: report.level,
    normalizations: report.normalizations.map((n) => n.names),
    differences: report.differences,
  }).toEqual({ level: 'same', normalizations, differences: [] });
});

// The e2e/implicit-routing suite runs the waiting parallel join on Operaton.
it('nested inclusive joins name the join printed as parallel and the step a jump past one runs once per route for', async () => {
  const { ir } = await xmlToIr(bpmnDoc(nestedJoins('inclusiveGateway')));
  expect(irToDsl(ir).warnings.map((w) => w.message)).toEqual([
    [
      "inclusive gateway 'J1' was printed as the join of a 'parallel' block",
      'note: no branch of the block carries a condition, so the script reads the block back as parallel gateways',
      "note: a parallel join waits for a route from every branch, where 'J1' goes on once no other route can still reach it",
      'note: so a route led away from its branch before the join, by an interrupting boundary event for one, leaves the rebuilt process waiting at the join forever',
    ].join('\n'),
    ...['J2', 'J3'].map((join) =>
      [
        `a jump was printed past gateway '${join}' and its join was lost`,
        "note: the route into it has no form in the script, so it leaves as a jump to 'T'",
        `note: a route taking the jump goes on to 'T' at once instead of waiting at '${join}' for the others`,
        "note: so 'T' and what follows run once for each such route instead of once after the join",
      ].join('\n'),
    ),
  ]);
});

// Operaton fails every run of `T` with ENGINE-02005, and leaves the same
// routes through an inclusive fork's default (both in e2e/implicit-routing).
it("a repeated step's default prints as the fallback of a fork after it and is warned on import", async () => {
  const { ir, warnings } = await xmlToIr(
    bpmnDoc(
      [
        '<bpmn:startEvent id="S" />',
        '<bpmn:userTask id="T" default="Flow_T_D"><bpmn:multiInstanceLoopCharacteristics>' +
          '<bpmn:loopCardinality>2</bpmn:loopCardinality>' +
          '</bpmn:multiInstanceLoopCharacteristics></bpmn:userTask>',
        ...['A', 'B', 'D'].map((id) => `<bpmn:userTask id="${id}" />`),
        ...['A', 'B', 'D'].map((id) => `<bpmn:endEvent id="E${id}" />`),
        flows('S>T'),
        conditioned('T', 'A', '${x &gt; 1}'),
        conditioned('T', 'B', '${x &gt; 2}'),
        flows('T>D A>EA B>EB D>ED'),
      ].join('\n'),
    ),
  );
  expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
    ['behaviourChanged', 'T'],
  ]);
  const printed = irToDsl(ir);
  expect(printed.source).toBe(`process p {
  var x: any
  start S
  user T for 2
  parallel {
    if (x > 1) {
      user A
      end EA
    }
    if (x > 2) {
      user B
      end EB
    }
    else {
      user D
      end ED
    }
  }
}
`);
  expect(printed.warnings).toEqual([]);
  expect(await validationErrors(printed.source)).toEqual([]);
  const { ir2: rebuilt } = await roundTrip(printed.source);
  expect(compareModels(ir, rebuilt).level).toBe('changed');
});
