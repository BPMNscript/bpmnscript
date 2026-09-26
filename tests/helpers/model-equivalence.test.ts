import { describe, it, expect } from 'vitest';
import { astToIr } from '@bpmn-script/transform';
import type { BpmnProcess, FlowElement } from '@bpmn-script/transform';
import { compareModels, type ModelComparison } from './model-equivalence.js';
import { parseToAst } from './pipeline.js';

const compile = async (source: string) => astToIr(await parseToAst(source));

// Each `changed` row swaps one part of this baseline.
const ifA = (then: string, otherwise: string): string => `  if (a) {
    step ${then}
  } else {
    step ${otherwise}
  }`;
const ifB = `  if (b) {
    step W
  }`;
const PARTS = [
  ifA('X', 'Y'),
  `  parallel {
    {
      step P1
    }
    {
      step P2
    }
  }`,
  '  step Z(asyncBefore: true)',
  ifB,
];
const withPart = (index: number, part: string): string =>
  `process p {
  var a: any
  var b: any
${PARTS.map((p, i) => (i === index ? part : p)).join('\n')}
}`;
const base = withPart(-1, '');

const joinSource = `process p {
  if (true) (joinAsyncAfter: true) {
  } else {
    await timer Wait(at: "2027-01-01T00:00:00")
  }
  receive Pay
  goto Pay
}`;

const swappedGotos = (then: string, otherwise: string): string => `process p {
  var a: any
  step X
  step Y
  if (a) {
    await signal("Foo")
    goto ${then}
  } else {
    await signal("Foo")
    goto ${otherwise}
  }
}`;

const table: [title: string, a: string, b: string, want: ModelComparison][] = [
  [
    'a single-quoted and a double-quoted JUEL string are canonical',
    `process p {
  var x: any
  if ("\${x == 'a'}") {
    step A
  }
}`,
    `process p {
  var x: any
  if (x == "a") {
    step A
  }
}`,
    'canonical',
  ],
  [
    'two unnamed events printed in the other order are canonical',
    `process p {
  parallel {
    {
      await signal("A")
    }
    {
      await signal("B")
    }
  }
}`,
    `process p {
  parallel {
    {
      await signal("B")
    }
    {
      await signal("A")
    }
  }
}`,
    'canonical',
  ],
  [
    'two event handlers printed in the other order are canonical',
    `process p {
  step A
  on signal("A") {
    step HA
  }
  on signal("B") {
    step HB
  }
}`,
    `process p {
  step A
  on signal("B") {
    step HB
  }
  on signal("A") {
    step HA
  }
}`,
    'canonical',
  ],
  [
    'a branch printed after its block and reached by goto is restructured',
    `process p {
  if (true) {
    receive Approve
    emit signal("Shutdown")
    end Done
  } else if (true) {
    emit signal("Shutdown")
  }
  emit link("Skip")
  await link("Skip")
  end Done19
  on signal("Ready") {
    step Handle
  }
}`,
    `process p {
  if (true) {
    goto Approve
  } else if (true) {
    emit signal("Shutdown")
  }
  emit link("Skip")
  receive Approve
  emit signal("Shutdown")
  end Done
  await link("Skip")
  end Done19
  on signal("Ready") {
    step Handle
  }
}`,
    'restructured',
  ],
  [
    'a do-while printed as an if with a backward goto is the same model',
    `process p {
  var x: any
  var y: any
  if (x) {
    step A
  } else if (y) {
    do {
      step B
      call Call(process: "run")
    } while (y)
    call Call8(process: "run")
  } else {
    goto Call
  }
}`,
    `process p {
  var x: any
  var y: any
  if (x) {
    step A
  } else if (y) {
    step B
    call Call(process: "run")
    if (y) {
      goto B
    } else {
      call Call8(process: "run")
    }
  } else {
    goto Call
  }
}`,
    'same',
  ],
  [
    'swapped if and else bodies are changed',
    base,
    withPart(0, ifA('Y', 'X')),
    'changed',
  ],
  [
    'a condition replaced by true is changed',
    base,
    withPart(3, ifB.replace('(b)', '(true)')),
    'changed',
  ],
  [
    'asyncBefore dropped from a step is changed',
    base,
    withPart(2, '  step Z'),
    'changed',
  ],
  [
    'a parallel printed as a sequence is changed',
    base,
    withPart(1, '  step P1\n  step P2'),
    'changed',
  ],
  [
    'an added else branch is changed',
    base,
    withPart(3, ifB.replace(/\}$/, '} else {\n    step W2\n  }')),
    'changed',
  ],
  [
    "a route that skips an if's joinAsyncAfter join is changed",
    joinSource,
    `process p {
  if (true) (joinAsyncAfter: true) {
  } else {
    goto Wait
  }
  receive Pay
  goto Pay
  await timer Wait(at: "2027-01-01T00:00:00")
  goto Pay
}`,
    'changed',
  ],
  [
    'two identical unnamed events whose gotos are swapped are changed',
    swappedGotos('X', 'Y'),
    swappedGotos('Y', 'X'),
    'changed',
  ],
];

// Shapes the compiler never emits, as a modeler's document can: node kinds by
// id, and flows as `[id: ]source -> target[ ? condition]`.
const model = (
  kinds: Record<string, string>,
  flows: string[],
): BpmnProcess => ({
  id: 'p',
  isExecutable: true,
  flowElements: Object.entries(kinds).map(
    ([id, kind]) => ({ kind, id }) as FlowElement,
  ),
  sequenceFlows: flows.map((flow, i) => {
    const [, id = `Flow_${i}`, sourceRef, targetRef, condition] =
      /^(?:(\S+): )?(\S+) -> (\S+)(?: \? (.+))?$/.exec(flow)!;
    return {
      id,
      sourceRef,
      targetRef,
      ...(condition === undefined ? {} : { conditionExpression: condition }),
    };
  }),
});

// A parallel fork into A, B and C whose branches meet at `join`, A and B first
// through an exclusive merge when `merged`.
const forked = (join: string, merged = false): BpmnProcess =>
  model(
    {
      S: 'startEvent',
      F: 'parallelGateway',
      A: 'userTask',
      B: 'userTask',
      C: 'userTask',
      ...(merged ? { M: 'exclusiveGateway' } : {}),
      J: join,
      E: 'endEvent',
    },
    [
      'S -> F',
      'F -> A',
      'F -> B',
      'F -> C',
      ...(merged ? ['A -> M', 'B -> M', 'M -> J'] : ['A -> J', 'B -> J']),
      'C -> J',
      'J -> E',
    ],
  );
const chainedJoins = (end: string): BpmnProcess =>
  model(
    {
      T: 'userTask',
      Gateway_a_join: 'exclusiveGateway',
      Gateway_b_join: 'exclusiveGateway',
      E1: 'endEvent',
      E2: 'endEvent',
    },
    [
      'T -> Gateway_a_join',
      'Gateway_a_join -> Gateway_b_join',
      `Gateway_b_join -> ${end}`,
    ],
  );
const split = (routes: string[]): BpmnProcess =>
  model(
    { T: 'userTask', G: 'exclusiveGateway', A: 'userTask', B: 'userTask' },
    ['T -> G', ...routes],
  );
const documented = (ir: BpmnProcess, id: string): BpmnProcess => ({
  ...ir,
  flowElements: ir.flowElements.map((el) =>
    el.id === id ? { ...el, documentation: 'Why we merge' } : el,
  ),
});
const nestedSplits = (
  [outer, inner]: [string, string],
  merge?: string,
  flowId = (_n: number): string => '',
): BpmnProcess =>
  model(
    {
      T: 'userTask',
      A: 'userTask',
      B: 'userTask',
      C: 'userTask',
      D: 'userTask',
      [outer]: 'exclusiveGateway',
      [inner]: 'exclusiveGateway',
      ...(merge === undefined ? {} : { [merge]: 'exclusiveGateway' }),
    },
    [
      `T -> ${outer}`,
      `${outer} -> A ? \${a}`,
      `${outer} -> ${inner} ? \${b}`,
      `${inner} -> B ? \${c}`,
      `${inner} -> C ? \${d}`,
      ...(merge === undefined
        ? ['A -> D', 'B -> D', 'C -> D']
        : [`A -> ${merge}`, `B -> ${merge}`, `C -> ${merge}`, `${merge} -> D`]),
    ].map((flow, n) => flowId(n) + flow),
  );

const builtTable: [
  title: string,
  a: BpmnProcess,
  b: BpmnProcess,
  want: ModelComparison,
][] = [
  [
    'a parallel join and an exclusive join over the same branches are changed',
    forked('parallelGateway'),
    forked('exclusiveGateway'),
    'changed',
  ],
  [
    'an exclusive merge dropped in front of a parallel join is changed',
    forked('parallelGateway', true),
    forked('parallelGateway'),
    'changed',
  ],
  [
    'two chained joins leading to different ends are changed',
    chainedJoins('E1'),
    chainedJoins('E2'),
    'changed',
  ],
  [
    'swapped overlapping conditions at an exclusive split are changed',
    split(['G -> A ? ${a}', 'G -> B ? ${a}']),
    split(['G -> B ? ${a}', 'G -> A ? ${a}']),
    'changed',
  ],
  [
    'a route with no condition swapped with a conditioned one at an exclusive split is changed',
    split(['G -> A', 'G -> B ? ${a}']),
    split(['G -> B ? ${a}', 'G -> A']),
    'changed',
  ],
  [
    'an event-based gateway with one route out is not a transparent merge',
    model(
      { T: 'userTask', R: 'eventBasedGateway', W: 'intermediateCatchEvent' },
      ['T -> R', 'R -> W'],
    ),
    model({ T: 'userTask', W: 'intermediateCatchEvent' }, ['T -> W']),
    'changed',
  ],
  [
    "a modeler's own flow and gateway ids and an extra merge are the same model",
    nestedSplits(['Gateway_p_0_split', 'Gateway_p_1_split']),
    nestedSplits(
      ['Gateway_0x', 'Gateway_1y'],
      'Gateway_2z',
      (n) => `SequenceFlow_${n}: `,
    ),
    'same',
  ],
  [
    'documentation on an otherwise transparent merge is changed',
    nestedSplits(['G1', 'G2'], 'M'),
    documented(nestedSplits(['G1', 'G2'], 'M'), 'M'),
    'changed',
  ],
];

describe('compareModels', () => {
  it.each(table)('%s', async (_title, a, b, want) => {
    expect(compareModels(await compile(a), await compile(b))).toBe(want);
  });

  it.each(builtTable)('%s', (_title, a, b, want) => {
    expect(compareModels(a, b)).toBe(want);
  });
});
