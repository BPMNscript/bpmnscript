// The routing a model can leave to its nodes, run on Operaton next to the same
// model with the end event or gateway written out: what the comparison
// helper's `implicit-end` and `uncontrolled-flow` take as equal must behave
// the same, and what they keep apart must not.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xmlToIr } from '@bpmn-script/transform';

import type { FixtureAdapter } from '../fixtures/index.js';
import { startFixture } from '../fixtures/index.js';
import {
  DEPLOY_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activeTaskKeys,
  isRunning,
  jobDefinitionsFor,
  jobsOfInstance,
  setJobDefinitionSuspended,
  waitFor,
  waitForTaskId,
} from '../helpers/engine-rest.js';
import { compareModels } from '../helpers/model-equivalence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `kind id attributes` per node, `|` before a child element; `a -> b ? cond`
// per flow, its id `f_a_b`.
type Model = { nodes: string[]; flows: string[] };

const ASYNC_AFTER = 'operaton:asyncAfter="true"';
const ONE_RUN =
  '<multiInstanceLoopCharacteristics><loopCardinality>1</loopCardinality></multiInstanceLoopCharacteristics>';

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function processXml(id: string, { nodes, flows }: Model): string {
  const elements = nodes.map((node) => {
    const [head, child = ''] = node.split(' | ');
    const [kind, nodeId, ...attributes] = head.split(' ');
    return `<${kind} id="${nodeId}" ${attributes.join(' ')}>${child}</${kind}>`;
  });
  const sequenceFlows = flows.map((flow) => {
    const [, source, target, condition] = /^(\S+) -> (\S+)(?: \? (.+))?$/.exec(
      flow,
    )!;
    const body =
      condition === undefined
        ? ''
        : `<conditionExpression xsi:type="tFormalExpression">${escape(condition)}</conditionExpression>`;
    return `<sequenceFlow id="f_${source}_${target}" sourceRef="${source}" targetRef="${target}">${body}</sequenceFlow>`;
  });
  return `<process id="${id}" isExecutable="true" operaton:historyTimeToLive="P1D">
${[...elements, ...sequenceFlows].join('\n')}
</process>`;
}

const START = 'startEvent S';
const T = 'userTask T';
const tasks = (...ids: string[]) => ids.map((id) => `userTask ${id}`);
// T leaving for A on `x > 1`, B on `x > 2`, and D by default, through an
// inclusive fork when `fork`; `child` goes into T.
const conditional = (fork: boolean, child = ''): Model => {
  const from = fork ? 'G' : 'T';
  const fallback = `default="f_${from}_D"`;
  return {
    nodes: [
      START,
      `${T} ${fork ? '' : fallback}${child}`,
      ...(fork ? [`inclusiveGateway G ${fallback}`] : []),
      ...tasks('A', 'B', 'D'),
    ],
    flows: [
      'S -> T',
      ...(fork ? ['T -> G'] : []),
      `${from} -> A ? \${x > 1}`,
      `${from} -> B ? \${x > 2}`,
      `${from} -> D`,
    ],
  };
};
// T leaving for A and B on the conditions given, through a `fork` gateway when
// one is named; `extra` adds attributes to T.
const twoWay = (
  fork: string | undefined,
  [toA, toB]: (string | undefined)[],
  extra = '',
): Model => {
  const from = fork === undefined ? 'T' : 'G';
  const on = (cond?: string) => (cond === undefined ? '' : ` ? ${cond}`);
  return {
    nodes: [
      START,
      `${T} ${extra}`,
      ...(fork === undefined ? [] : [`${fork} G`]),
      ...tasks('A', 'B'),
    ],
    flows: [
      'S -> T',
      ...(fork === undefined ? [] : ['T -> G']),
      `${from} -> A${on(toA)}`,
      `${from} -> B${on(toB)}`,
    ],
  };
};
const BOTH = ['${x > 1}', '${x > 2}'];
// A fork into A and a sub-process P that throws at once, caught on P and led
// away to E2, both kinds `kind`, joined before C.
const diverted = (kind: string): Model => ({
  nodes: [
    START,
    `${kind} F`,
    'userTask A',
    'subProcess P | <startEvent id="PS" /><endEvent id="PE"><errorEventDefinition errorRef="Err" /></endEvent><sequenceFlow id="f_PS_PE" sourceRef="PS" targetRef="PE" />',
    'boundaryEvent X attachedToRef="P" | <errorEventDefinition />',
    `${kind} J`,
    'userTask C',
    'endEvent E2',
  ],
  flows: [
    'S -> F',
    'F -> A',
    'F -> P',
    'A -> J',
    'P -> J',
    'J -> C',
    'X -> E2',
  ],
});

interface Pair {
  key: string;
  direct: Model;
  // Where the end event is minted, its id names the process `${key}-x`.
  written: Model;
  // Names the comparison helper needs, or `changed` where it keeps them apart.
  verdict: string[][] | 'changed';
}

const PAIRS: Pair[] = [
  {
    key: 'implicit-end',
    direct: { nodes: [START, T], flows: ['S -> T'] },
    written: {
      nodes: [START, T, 'endEvent EndEvent_implicit-end-x'],
      flows: ['S -> T', 'T -> EndEvent_implicit-end-x'],
    },
    verdict: [['synthesized-ids'], ['implicit-end']],
  },
  {
    key: 'implicit-end-async',
    direct: { nodes: [START, `${T} ${ASYNC_AFTER}`], flows: ['S -> T'] },
    written: {
      nodes: [
        START,
        `${T} ${ASYNC_AFTER}`,
        'endEvent EndEvent_implicit-end-async-x',
      ],
      flows: ['S -> T', 'T -> EndEvent_implicit-end-async-x'],
    },
    verdict: [['synthesized-ids'], ['implicit-end']],
  },
  {
    key: 'implicit-merge',
    direct: {
      nodes: [START, 'parallelGateway F', ...tasks('A', 'B', 'C')],
      flows: ['S -> F', 'F -> A', 'F -> B', 'A -> C', 'B -> C'],
    },
    written: {
      nodes: [
        START,
        'parallelGateway F',
        ...tasks('A', 'B', 'C'),
        'exclusiveGateway M',
      ],
      flows: ['S -> F', 'F -> A', 'F -> B', 'A -> M', 'B -> M', 'M -> C'],
    },
    verdict: [['synthesized-ids'], ['uncontrolled-flow']],
  },
  {
    key: 'implicit-split',
    direct: twoWay(undefined, []),
    written: twoWay('parallelGateway', []),
    verdict: [['synthesized-ids'], ['uncontrolled-flow']],
  },
  {
    key: 'conditional-split',
    direct: conditional(false),
    written: conditional(true),
    verdict: [['synthesized-ids'], ['uncontrolled-flow']],
  },
  {
    key: 'conditional-split-no-default',
    direct: twoWay(undefined, BOTH),
    written: twoWay('inclusiveGateway', BOTH),
    verdict: [['synthesized-ids'], ['uncontrolled-flow']],
  },
  {
    key: 'mixed-split',
    direct: twoWay(undefined, ['${x > 1}']),
    written: twoWay('inclusiveGateway', ['${x > 1}']),
    verdict: [['synthesized-ids'], ['uncontrolled-flow']],
  },
  {
    key: 'split-async',
    direct: twoWay(undefined, [], ASYNC_AFTER),
    written: twoWay('parallelGateway', [], ASYNC_AFTER),
    verdict: 'changed',
  },
  {
    key: 'diverted-join',
    direct: diverted('inclusiveGateway'),
    written: diverted('parallelGateway'),
    verdict: 'changed',
  },
  {
    key: 'loop-default',
    direct: conditional(false, ` | ${ONE_RUN}`),
    written: conditional(true, ` | ${ONE_RUN}`),
    verdict: 'changed',
  },
];

// What a run left after each step: open tasks, jobs, whether the instance
// still runs, and whether the engine refused the step.
interface Observation {
  tasks: string[];
  jobs: number;
  running: boolean;
  refused?: true;
}

describe.skipIf(SKIP)('E2E: routing left to the nodes on Operaton', () => {
  let fixture: FixtureAdapter;

  // Element ids repeat across the processes, so each goes in its own document.
  beforeAll(async () => {
    fixture = startFixture();
    for (const [id, model] of PAIRS.flatMap(({ key, direct, written }) => [
      [key, direct] as const,
      [`${key}-x`, written] as const,
    ])) {
      const xmlPath = resolve(
        __dirname,
        `../../out/implicit-routing/${id}.bpmn`,
      );
      mkdirSync(dirname(xmlPath), { recursive: true });
      writeFileSync(xmlPath, wrap(processXml(id, model)));
      const { deploymentId } = await fixture.deploy(xmlPath, `${id}-test`);
      expect(deploymentId).toBeTruthy();
    }
  }, DEPLOY_TIMEOUT_MS);

  // A suspended job definition holds each asyncAfter job for counting.
  async function run(
    key: string,
    variables: Record<string, unknown>,
    steps: string[],
  ): Promise<Observation[]> {
    const holds = await jobDefinitionsFor(fixture, key, 'T');
    for (const { id } of holds) {
      await setJobDefinitionSuspended(fixture, id, true);
    }
    const { processInstanceId } = await fixture.startProcess(key, variables);
    const observations: Observation[] = [];
    for (const step of steps) {
      let refused = false;
      if (step === 'resume') {
        for (const { id } of holds) {
          await setJobDefinitionSuspended(fixture, id, false);
        }
        await waitFor(
          () => isRunning(fixture, processInstanceId),
          (running) => !running,
        );
      } else {
        const taskId = await waitForTaskId(fixture, processInstanceId, step);
        refused = await fixture.completeTask(taskId).then(
          () => false,
          () => true,
        );
      }
      const running = await isRunning(fixture, processInstanceId);
      observations.push({
        tasks: running
          ? activeTaskKeys(await fixture.getActiveTasks(processInstanceId))
          : [],
        jobs: running
          ? (await jobsOfInstance(fixture, processInstanceId)).length
          : 0,
        running,
        ...(refused ? { refused } : {}),
      });
    }
    return observations;
  }

  it.each<[string, string, Record<string, unknown>, string[], Observation[]]>([
    [
      'a task with no outgoing flow ends the instance like one followed by an end event',
      'implicit-end',
      {},
      ['T'],
      [{ tasks: [], jobs: 0, running: false }],
    ],
    [
      'with asyncAfter, a task with no outgoing flow leaves the same single job, which ends the instance',
      'implicit-end-async',
      {},
      ['T', 'resume'],
      [
        { tasks: [], jobs: 1, running: true },
        { tasks: [], jobs: 0, running: false },
      ],
    ],
    [
      'two flows entering a task start it once per token, like an exclusive merge',
      'implicit-merge',
      {},
      ['A', 'B'],
      [
        { tasks: ['B', 'C'], jobs: 0, running: true },
        { tasks: ['C', 'C'], jobs: 0, running: true },
      ],
    ],
    [
      'two unconditioned flows leaving a task start both branches, like a parallel fork',
      'implicit-split',
      {},
      ['T'],
      [{ tasks: ['A', 'B'], jobs: 0, running: true }],
    ],
    [
      'conditioned flows leaving a task start every branch whose condition holds, like an inclusive fork',
      'conditional-split',
      { x: 3 },
      ['T'],
      [{ tasks: ['A', 'B'], jobs: 0, running: true }],
    ],
    [
      "a task's default flow is taken only when no condition holds, like an inclusive fork's",
      'conditional-split',
      { x: 0 },
      ['T'],
      [{ tasks: ['D'], jobs: 0, running: true }],
    ],
    [
      'with no condition holding and no default, completing the task is refused, as at an inclusive fork',
      'conditional-split-no-default',
      { x: 0 },
      ['T'],
      [{ tasks: ['T'], jobs: 0, running: true, refused: true }],
    ],
    [
      'an unconditioned flow beside a conditioned one is always taken, as at an inclusive fork',
      'mixed-split',
      { x: 0 },
      ['T'],
      [{ tasks: ['B'], jobs: 0, running: true }],
    ],
  ])(
    '%s',
    async (_title, key, variables, steps, want) => {
      expect(await run(key, variables, steps)).toEqual(want);
      expect(await run(`${key}-x`, variables, steps)).toEqual(want);
    },
    60_000,
  );

  it.each<
    [string, string, Record<string, unknown>, string, Observation, Observation]
  >([
    [
      'with asyncAfter, a task makes one job per branch where a task before a parallel fork makes one',
      'split-async',
      {},
      'T',
      { tasks: [], jobs: 2, running: true },
      { tasks: [], jobs: 1, running: true },
    ],
    [
      "a repeated task naming a default fails to leave, where it leaves fine through an inclusive fork's default",
      'loop-default',
      { x: 2 },
      'T',
      { tasks: ['T'], jobs: 0, running: true, refused: true },
      { tasks: ['A'], jobs: 0, running: true },
    ],
    [
      'an inclusive join goes on once a route is led away from it, where a parallel join waits for it forever',
      'diverted-join',
      {},
      'A',
      { tasks: ['C'], jobs: 0, running: true },
      { tasks: [], jobs: 0, running: true },
    ],
  ])(
    '%s',
    async (_title, key, variables, step, direct, written) => {
      expect(await run(key, variables, [step])).toEqual([direct]);
      expect(await run(`${key}-x`, variables, [step])).toEqual([written]);
    },
    60_000,
  );

  it('the comparison helper bridges exactly the pairs that ran the same', async () => {
    const verdicts = await Promise.all(
      PAIRS.map(async ({ key, direct, written }) => {
        const [a, b] = await Promise.all(
          [processXml(key, direct), processXml(`${key}-x`, written)].map(
            async (xml) => (await xmlToIr(wrap(xml))).ir,
          ),
        );
        const report = compareModels({ ...a, id: b.id }, b);
        return [
          key,
          report.level === 'changed'
            ? 'changed'
            : report.normalizations.map((n) => n.names),
        ];
      }),
    );
    expect(verdicts).toEqual(PAIRS.map(({ key, verdict }) => [key, verdict]));
  });
});

const wrap = (processes: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:operaton="http://operaton.org/schema/1.0/bpmn" targetNamespace="http://bpmnscript.test/implicit-routing">
<error id="Err" errorCode="e" />
${processes}
</definitions>`;
