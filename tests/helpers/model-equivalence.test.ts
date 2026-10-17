import { describe, it, expect } from 'vitest';
import { astToIr, HISTORY_TIME_TO_LIVE } from '@bpmn-script/transform';
import type { BpmnProcess, FlowElement } from '@bpmn-script/transform';
import {
  compareModels,
  type ModelComparison,
  type ModelReport,
  type NormalizationName,
} from './model-equivalence.js';
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
const split = (routes: string[], kind = 'exclusiveGateway'): BpmnProcess =>
  model({ T: 'userTask', G: kind, A: 'userTask', B: 'userTask' }, [
    'T -> G',
    ...routes,
  ]);
// A parallel fork F into A and, through a second fork G, into B and C, or F
// into all three; `condition` goes on the route into C.
const innerFork = (condition = ''): BpmnProcess =>
  model(
    {
      S: 'startEvent',
      F: 'parallelGateway',
      G: 'parallelGateway',
      A: 'userTask',
      B: 'userTask',
      C: 'userTask',
    },
    ['S -> F', 'F -> A', 'F -> G', 'G -> B', `G -> C${condition}`],
  );
const flatFork = (condition = ''): BpmnProcess =>
  model(
    {
      S: 'startEvent',
      F: 'parallelGateway',
      A: 'userTask',
      B: 'userTask',
      C: 'userTask',
    },
    ['S -> F', 'F -> A', 'F -> B', `F -> C${condition}`],
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

const withFields = (
  ir: BpmnProcess,
  id: string,
  fields: Record<string, unknown>,
): BpmnProcess => ({
  ...ir,
  flowElements: ir.flowElements.map((el) =>
    el.id === id ? ({ ...el, ...fields } as FlowElement) : el,
  ),
});
const message = (messageName: string) => ({
  eventDefinition: { kind: 'message', messageName },
});
// A task, then a race between two message catches, each to its own task.
const race = (catchId: string): BpmnProcess =>
  withFields(
    withFields(
      model(
        {
          T: 'userTask',
          R: 'eventBasedGateway',
          [catchId]: 'intermediateCatchEvent',
          Catch_p_0_b1: 'intermediateCatchEvent',
          A: 'userTask',
          B: 'userTask',
        },
        ['T -> R', `R -> ${catchId}`, 'R -> Catch_p_0_b1', `${catchId} -> A`],
      ),
      catchId,
      message('Paid'),
    ),
    'Catch_p_0_b1',
    message('Cancelled'),
  );
const choice = (gateway = 'G', condition = '${a}'): BpmnProcess =>
  model(
    {
      T: 'userTask',
      [gateway]: 'exclusiveGateway',
      A: 'userTask',
      B: 'userTask',
    },
    [`T -> ${gateway}`, `${gateway} -> A ? ${condition}`, `${gateway} -> B`],
  );
const reversed = (ir: BpmnProcess): BpmnProcess => ({
  ...ir,
  flowElements: [...ir.flowElements].reverse(),
  sequenceFlows: [...ir.sequenceFlows].reverse(),
});
const merged = (merge: string): BpmnProcess =>
  model({ A: 'userTask', [merge]: 'exclusiveGateway', B: 'userTask' }, [
    `f1: A -> ${merge}`,
    `f2: ${merge} -> B`,
  ]);
const singleRoute = (kind: string, condition: string): BpmnProcess =>
  model({ A: 'userTask', M: kind, B: 'userTask' }, [
    'A -> M',
    `M -> B${condition}`,
  ]);

const boundaryEscape = (endId: string): BpmnProcess => {
  const ir = model(
    {
      A: 'userTask',
      Boundary_x: 'boundaryEvent',
      [endId]: 'endEvent',
    },
    ['Boundary_x -> ' + endId],
  );
  return withFields(ir, 'Boundary_x', {
    attachedToRef: 'A',
    eventDefinition: message('Stop').eventDefinition,
  });
};

const bridged = (
  level: ModelComparison,
  names: NormalizationName[],
  elements: string[],
): ModelReport => ({
  level,
  normalizations: [{ names, elements }],
  differences: [],
});
// The gateway that stays, and its flows, against the one flow that replaces
// them where the gateway is inlined.
const keptGateway = (kind: string): ModelReport => {
  const gateway = `Gateway_${kind}_[in:A]_[out:B]`;
  return {
    level: 'changed',
    normalizations: [],
    differences: [
      gateway,
      `Flow_A_${gateway}`,
      `Flow_${gateway}_B`,
      'Flow_A_B',
    ].map((element, i) => ({
      container: 'p',
      element,
      only: i < 3 ? 'a' : 'b',
      fields: [],
    })),
  };
};
const CHOICE = 'Gateway_exclusiveGateway_[in:T]_[out:A,B]';
const SPLIT = 'Gateway_p_0_split';
const MERGE = 'Gateway_exclusiveGateway_[in:T]_[out:A]';
const FORK = 'Gateway_parallelGateway_[in:T]_[out:B,C]';
const JOIN = 'Gateway_exclusiveGateway_[in:A,B]_[out:C]';
const OUTER_FORK = 'Gateway_parallelGateway_[in:S]_[out:B,C]';
// A start and a task, then the end `endId` or none.
const stops = (endId?: string): BpmnProcess =>
  endId === undefined
    ? model({ S: 'startEvent', T: 'userTask' }, ['S -> T'])
    : model({ S: 'startEvent', T: 'userTask', [endId]: 'endEvent' }, [
        'S -> T',
        `T -> ${endId}`,
      ]);

const reportTable: [
  title: string,
  a: BpmnProcess,
  b: BpmnProcess,
  want: ModelReport,
][] = [
  [
    'identical models',
    choice(),
    choice(),
    { level: 'same', normalizations: [], differences: [] },
  ],
  [
    'a race whose catch events carry modeler ids',
    race('Event_0abc'),
    race('Catch_p_0_b0'),
    bridged(
      'canonical',
      ['synthesized-ids'],
      ['p/Catch_p_0_b0', 'p/Event_0abc', 'p/Flow_1', 'p/Flow_3'],
    ),
  ],
  [
    'a hand-named and a synthesized split',
    choice('G'),
    choice('Gateway_p_0_split'),
    bridged(
      'same',
      ['synthesized-ids'],
      ['p/Flow_0', 'p/Flow_1', 'p/Flow_2', 'p/G', 'p/Gateway_p_0_split'],
    ),
  ],
  [
    'a named and an unnamed gateway',
    withFields(choice(), 'G', { name: 'Paid?' }),
    choice(),
    bridged('same', ['gateway-names'], [`p/${CHOICE}`]),
  ],
  [
    'an extra settings-free merge',
    model({ T: 'userTask', M: 'exclusiveGateway', A: 'userTask' }, [
      'T -> M',
      'M -> A',
    ]),
    model({ T: 'userTask', A: 'userTask' }, ['T -> A']),
    bridged(
      'same',
      ['pass-through-gateways'],
      [`p/Flow_${MERGE}_A`, 'p/Flow_T_A', `p/Flow_T_${MERGE}`, `p/${MERGE}`],
    ),
  ],
  [
    'reversed element order',
    forked('parallelGateway'),
    reversed(forked('parallelGateway')),
    bridged('same', ['element-order'], ['p']),
  ],
  [
    'a single-quoted and a double-quoted JUEL string',
    choice('G', "${x == 'a'}"),
    choice('G', '${x == "a"}'),
    bridged('canonical', ['expression-parse-trees'], [`p/Flow_${CHOICE}_A`]),
  ],
  [
    'an original without a history time to live against a rebuild with the default',
    choice(),
    { ...choice(), historyTimeToLive: HISTORY_TIME_TO_LIVE },
    bridged('same', ['default-history-time-to-live'], ['p']),
  ],
  [
    'an original without a history time to live against a rebuild with a non-default value is a difference',
    choice(),
    { ...choice(), historyTimeToLive: 'P7D' },
    {
      level: 'changed',
      normalizations: [],
      differences: [
        {
          container: 'p',
          element: 'p',
          fields: [{ path: 'historyTimeToLive', b: 'P7D' }],
        },
      ],
    },
  ],
  [
    'a pass-through merge under different gateway ids on each side, flow ids equal, is bridged only by synthesized ids and pass-through gateways together',
    merged('M'),
    merged('N'),
    bridged(
      'same',
      ['synthesized-ids', 'pass-through-gateways'],
      ['p/M', 'p/N', 'p/f1', 'p/f2'],
    ),
  ],
  [
    'a changed pair reports no normalizations, though switching some off re-keys or widens its remaining difference',
    withFields(choice(SPLIT), SPLIT, { name: 'Paid?', documentation: 'x' }),
    withFields(choice(SPLIT), SPLIT, { documentation: 'y' }),
    {
      level: 'changed',
      normalizations: [],
      differences: [
        {
          container: 'p',
          element: CHOICE,
          fields: [{ path: 'documentation', a: 'x', b: 'y' }],
        },
      ],
    },
  ],
  [
    'a boundary-escape end named for a hand-named boundary against the container end',
    boundaryEscape('EndEvent_Boundary_x'),
    boundaryEscape('EndEvent_p'),
    bridged(
      'canonical',
      ['synthesized-ids'],
      ['p/EndEvent_Boundary_x', 'p/EndEvent_p', 'p/Flow_0'],
    ),
  ],
  [
    'a branch that stops against the same branch closed by the minted end',
    stops(),
    stops('EndEvent_p'),
    {
      level: 'canonical',
      normalizations: [
        { names: ['synthesized-ids'], elements: ['p/EndEvent_p', 'p/Flow_1'] },
        {
          names: ['implicit-end'],
          elements: ['p/Flow_T_endEvent:', 'p/endEvent:'],
        },
      ],
      differences: [],
    },
  ],
  ...(
    [
      ['an authored id', stops('Done'), 'Done'],
      [
        'a name',
        withFields(stops('EndEvent_p'), 'EndEvent_p', { name: 'x' }),
        'endEvent:',
      ],
    ] as const
  ).map(([what, b, end]): [string, BpmnProcess, BpmnProcess, ModelReport] => [
    `a branch that stops against an end with ${what} is a difference`,
    stops(),
    b,
    {
      level: 'changed',
      normalizations: [],
      differences: [end, `Flow_T_${end}`].map((element) => ({
        container: 'p',
        element,
        only: 'b',
        fields: [],
      })),
    },
  ]),
  [
    'an unconditioned last route of an exclusive split against the same route as its default',
    split(['G -> A ? ${a}', 'G -> B']),
    withFields(split(['G -> A ? ${a}', 'G -> B']), 'G', {
      defaultFlowId: 'Flow_2',
    }),
    bridged('same', ['unconditioned-last-route'], [`p/${CHOICE}`]),
  ],
  [
    'a settings-free fork behind a fork against one flat fork',
    innerFork(),
    flatFork(),
    {
      level: 'same',
      normalizations: [
        {
          names: ['synthesized-ids'],
          elements: ['p/Flow_2', 'p/Flow_3', 'p/Flow_4'],
        },
        {
          names: ['nested-forks'],
          elements: [
            `p/Flow_${OUTER_FORK}_B`,
            `p/Flow_${OUTER_FORK}_C`,
            'p/Flow_S_B',
            'p/Flow_S_C',
            `p/Flow_S_${OUTER_FORK}`,
            `p/${OUTER_FORK}`,
          ],
        },
      ],
      differences: [],
    },
  ],
  [
    'two flows leaving a task against a parallel fork after it',
    model({ T: 'userTask', B: 'userTask', C: 'userTask' }, [
      'f1: T -> B',
      'f2: T -> C',
    ]),
    model(
      { T: 'userTask', F: 'parallelGateway', B: 'userTask', C: 'userTask' },
      ['f0: T -> F', 'f1: F -> B', 'f2: F -> C'],
    ),
    bridged(
      'same',
      ['uncontrolled-flow'],
      [
        `p/Flow_${FORK}_B`,
        `p/Flow_${FORK}_C`,
        'p/Flow_T_B',
        'p/Flow_T_C',
        `p/Flow_T_${FORK}`,
        `p/${FORK}`,
      ],
    ),
  ],
  [
    'two flows entering a task against an exclusive merge in front of it',
    model({ A: 'userTask', B: 'userTask', C: 'userTask' }, [
      'A -> C',
      'B -> C',
    ]),
    model(
      { A: 'userTask', B: 'userTask', M: 'exclusiveGateway', C: 'userTask' },
      ['A -> M', 'B -> M', 'M -> C'],
    ),
    bridged(
      'same',
      ['uncontrolled-flow'],
      [
        'p/Flow_A_C',
        `p/Flow_A_${JOIN}`,
        'p/Flow_B_C',
        `p/Flow_B_${JOIN}`,
        `p/Flow_${JOIN}_C`,
        `p/${JOIN}`,
      ],
    ),
  ],
  ...['exclusiveGateway', 'inclusiveGateway'].map(
    (kind): [string, BpmnProcess, BpmnProcess, ModelReport] => [
      `two models that differ only in the condition on the single outgoing flow of an ${kind} are reported as differing`,
      singleRoute(kind, ' ? ${x}'),
      singleRoute(kind, ''),
      keptGateway(kind),
    ],
  ),
];

// Documented, so it is not read as T's own split.
const documentedInclusive = documented(
  split(['G -> A ? ${a}', 'G -> B'], 'inclusiveGateway'),
  'G',
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
  // Each row breaks one condition for an end to stand for a branch that
  // stops, so dropping that one guard turns its row red.
  [
    'a minted end reached on a condition is changed',
    stops(),
    model({ S: 'startEvent', T: 'userTask', EndEvent_p: 'endEvent' }, [
      'S -> T',
      'T -> EndEvent_p ? ${x}',
    ]),
    'changed',
  ],
  [
    'a minted end beside another flow of its source is changed',
    model({ S: 'startEvent', T: 'userTask', B: 'userTask' }, [
      'S -> T',
      'f: T -> B',
    ]),
    model(
      {
        S: 'startEvent',
        T: 'userTask',
        B: 'userTask',
        EndEvent_p: 'endEvent',
      },
      ['S -> T', 'f: T -> B', 'T -> EndEvent_p'],
    ),
    'changed',
  ],
  // Each row breaks one condition for a route or a fork to compare as the
  // printer's rewrite of it, so dropping that one guard turns its row red.
  [
    'an unconditioned last route of an inclusive gateway against the same route as its default is changed',
    documentedInclusive,
    withFields(documentedInclusive, 'G', { defaultFlowId: 'Flow_2' }),
    'changed',
  ],
  [
    'an unconditioned route ahead of a conditioned one at an exclusive split against the same route as its default is changed',
    split(['G -> A', 'G -> B ? ${a}']),
    withFields(split(['G -> A', 'G -> B ? ${a}']), 'G', {
      defaultFlowId: 'Flow_1',
    }),
    'changed',
  ],
  [
    'a fork with a job setting behind a fork against one flat fork is changed',
    withFields(innerFork(), 'G', { asyncBefore: true }),
    flatFork(),
    'changed',
  ],
  [
    'a fork with a conditioned route behind a fork against one flat fork is changed',
    innerFork(' ? ${c}'),
    flatFork(' ? ${c}'),
    'changed',
  ],
  [
    'a fork behind a fork that continues after its job against one flat fork is changed',
    withFields(innerFork(), 'F', { asyncAfter: true }),
    withFields(flatFork(), 'F', { asyncAfter: true }),
    'changed',
  ],
  [
    'an exclusive split behind a fork against one flat fork is restructured',
    withFields(innerFork(), 'G', { kind: 'exclusiveGateway' }),
    flatFork(),
    'restructured',
  ],
  [
    'a fork behind an exclusive split against one flat split is changed',
    withFields(innerFork(), 'F', { kind: 'exclusiveGateway' }),
    withFields(flatFork(), 'F', { kind: 'exclusiveGateway' }),
    'changed',
  ],
  [
    'a fork that a second flow also enters behind a fork against one flat fork is changed',
    model(
      {
        S: 'startEvent',
        T: 'userTask',
        F: 'parallelGateway',
        G: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
        C: 'userTask',
      },
      ['S -> F', 'F -> A', 'F -> G', 'T -> G', 'G -> B', 'G -> C'],
    ),
    model(
      {
        S: 'startEvent',
        T: 'userTask',
        F: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
        C: 'userTask',
      },
      ['S -> F', 'F -> A', 'F -> B', 'F -> C'],
    ),
    'changed',
  ],
  [
    'a fork behind a fork on a conditioned flow against one flat fork is changed',
    model(
      {
        S: 'startEvent',
        F: 'parallelGateway',
        G: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
        C: 'userTask',
      },
      ['S -> F', 'F -> A', 'F -> G ? ${c}', 'G -> B', 'G -> C'],
    ),
    flatFork(),
    'changed',
  ],
  [
    'a fork with no route out behind a fork against the outer fork alone is restructured',
    model(
      {
        S: 'startEvent',
        F: 'parallelGateway',
        G: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
      },
      ['S -> F', 'F -> A', 'F -> B', 'F -> G'],
    ),
    model(
      { S: 'startEvent', F: 'parallelGateway', A: 'userTask', B: 'userTask' },
      ['S -> F', 'F -> A', 'F -> B'],
    ),
    'restructured',
  ],
  [
    'two forks that only feed each other, splitting their routes differently, are restructured',
    model(
      {
        S: 'startEvent',
        E: 'endEvent',
        G1: 'parallelGateway',
        G2: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
        C: 'userTask',
      },
      ['S -> E', 'G1 -> G2', 'G1 -> A', 'G2 -> G1', 'G2 -> B', 'G2 -> C'],
    ),
    model(
      {
        S: 'startEvent',
        E: 'endEvent',
        G1: 'parallelGateway',
        G2: 'parallelGateway',
        A: 'userTask',
        B: 'userTask',
        C: 'userTask',
      },
      ['S -> E', 'G1 -> G2', 'G1 -> A', 'G1 -> B', 'G2 -> G1', 'G2 -> C'],
    ),
    'restructured',
  ],
];

describe('compareModels', () => {
  it.each(reportTable)('%s', (_title, a, b, want) => {
    expect(compareModels(a, b)).toEqual(want);
  });

  it.each(table)('%s', async (_title, a, b, want) => {
    expect(compareModels(await compile(a), await compile(b)).level).toBe(want);
  });

  it.each(builtTable)('%s', (_title, a, b, want) => {
    expect(compareModels(a, b).level).toBe(want);
  });
});
