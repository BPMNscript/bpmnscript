import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { astToIr, irToXml } from '@bpmn-script/transform';

import type { ActiveTask, FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  DEPLOY_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activityIdsIncluding,
  engineGet,
  historicActivities,
  waitForTaskKeys,
  waitForTasks,
  waitUntilFinished,
} from '../helpers/engine-rest.js';
import { parseToAst, validationErrors } from '../helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROCESS_KEY = 'batch-approval';

const EMPTY_KEY = 'empty-batch';

const DOCUMENTED_KEY = 'documented-repetition';

// The engine reads a loop count and a completion condition untrimmed, so the
// documentation child beside each must leave the value it documents intact.
const DOCUMENTED_SOURCE = `process ${DOCUMENTED_KEY} {
  start Opened
  user Approve for 3(assignee: "demo", countDocumentation: "One approval per board member.")
  subprocess Lines {
    input lines = ["ann", "bob", "cal"]
  } {
    user Review for each line in lines(assignee: "demo", eachDocumentation: "The line this run reviews.")
  }
  user Check for 3 sequentially until (nrOfCompletedInstances >= 2, conditionDocumentation: "Two checks are enough.")(assignee: "demo")
  end Closed
}
`;

describe.skipIf(SKIP)('E2E: repetition on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(PROCESS_KEY, EMPTY_KEY);
  }, DEPLOY_TIMEOUT_MS);

  async function tasksOf(
    instanceId: string,
    key: string,
    count: number,
  ): Promise<ActiveTask[]> {
    const tasks = await waitForTasks(
      fixture,
      instanceId,
      (list) =>
        list.filter((task) => task.taskDefinitionKey === key).length >= count,
    );
    return tasks.filter((task) => task.taskDefinitionKey === key);
  }

  async function completeAll(
    instanceId: string,
    key: string,
    count: number,
  ): Promise<void> {
    for (const task of await tasksOf(instanceId, key, count)) {
      await fixture.completeTask(task.id);
    }
  }

  async function completeInTurn(
    instanceId: string,
    key: string,
    runs: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let run = 0; run < runs; run += 1) {
      const open = await tasksOf(instanceId, key, 1);
      expect(
        open.map((task) => task.id),
        `run ${run + 1} of ${key} was not offered alone`,
      ).toHaveLength(1);
      ids.push(open[0].id);
      await fixture.completeTask(open[0].id);
    }
    return ids;
  }

  // Values stay serialized so the read never depends on how the engine stored
  // the list itself.
  async function boundElement(taskId: string): Promise<unknown> {
    const variables = await engineGet<Record<string, { value: unknown }>>(
      fixture,
      `/engine-rest/task/${encodeURIComponent(taskId)}/variables?deserializeValues=false`,
      `taskVariables(${taskId})`,
    );
    return variables.line?.value;
  }

  async function walkToReview(): Promise<string> {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await completeAll(processInstanceId, 'CollectApprovals', 3);
    await completeInTurn(processInstanceId, 'SignOff', 3);
    await completeInTurn(processInstanceId, 'SpotCheck', 2);
    // The review tasks are the walk's postcondition: reaching them is what says
    // the token left the spot check rather than parking inside it.
    expect(
      await tasksOf(processInstanceId, 'ReviewLine', 3),
      'the walk never reached the review sub-process',
    ).toHaveLength(3);
    return processInstanceId;
  }

  it('offers every run of a parallel repetition at once', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    expect(
      await waitForTaskKeys(
        fixture,
        processInstanceId,
        (keys) => keys.length >= 3,
      ),
    ).toEqual(['CollectApprovals', 'CollectApprovals', 'CollectApprovals']);
  }, 60_000);

  it('opens one run of a sequential repetition at a time, on the one activity', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await completeAll(processInstanceId, 'CollectApprovals', 3);

    const ids = await completeInTurn(processInstanceId, 'SignOff', 3);

    expect(new Set(ids).size, 'the same task was offered twice').toBe(3);
  }, 60_000);

  it('ends a repetition as soon as its completion condition holds', async () => {
    const instanceId = await walkToReview();

    const runs = (await historicActivities(fixture, instanceId)).filter(
      (activity) => activity.activityId === 'SpotCheck',
    );
    expect(runs).toHaveLength(2);
    expect(
      (await fixture.getActiveTasks(instanceId)).map(
        (task) => task.taskDefinitionKey,
      ),
    ).not.toContain('SpotCheck');
  }, 60_000);

  it('runs a repeated service task once per count', async () => {
    const instanceId = await walkToReview();

    const runs = (await historicActivities(fixture, instanceId)).filter(
      (activity) => activity.activityId === 'LogEntry',
    );
    expect(runs.map((run) => run.endTime !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  }, 60_000);

  it('runs a repetition over a collection once per element, binding each one', async () => {
    const instanceId = await walkToReview();

    const tasks = await tasksOf(instanceId, 'ReviewLine', 3);
    expect(
      (await Promise.all(tasks.map((task) => boundElement(task.id)))).sort(),
    ).toEqual(['ann', 'bob', 'cal']);

    for (const task of tasks) {
      await fixture.completeTask(task.id);
    }

    expect(
      await waitForTaskKeys(fixture, instanceId, (keys) =>
        keys.includes('CloseBatch'),
      ),
    ).toEqual(['CloseBatch']);
  }, 60_000);

  it('runs a documented count, element variable and completion condition as written', async () => {
    expect(await validationErrors(DOCUMENTED_SOURCE)).toEqual([]);
    const xmlPath = resolve(__dirname, `../../out/${DOCUMENTED_KEY}.bpmn`);
    mkdirSync(dirname(xmlPath), { recursive: true });
    const xml = await irToXml(astToIr(await parseToAst(DOCUMENTED_SOURCE)));
    expect(xml.match(/<bpmn:documentation>/g)).toHaveLength(3);
    writeFileSync(xmlPath, xml);
    await fixture.deploy(xmlPath, `${DOCUMENTED_KEY}-test`);
    const { processInstanceId } = await fixture.startProcess(
      DOCUMENTED_KEY,
      {},
    );

    expect(
      await waitForTaskKeys(
        fixture,
        processInstanceId,
        (keys) => keys.length >= 3,
      ),
    ).toEqual(['Approve', 'Approve', 'Approve']);
    await completeAll(processInstanceId, 'Approve', 3);

    const reviews = await tasksOf(processInstanceId, 'Review', 3);
    expect(
      (await Promise.all(reviews.map((task) => boundElement(task.id)))).sort(),
    ).toEqual(['ann', 'bob', 'cal']);
    for (const task of reviews) {
      await fixture.completeTask(task.id);
    }

    await completeInTurn(processInstanceId, 'Check', 2);
    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
  }, 60_000);

  it('leaves a repetition of no runs without running it at all', async () => {
    const { processInstanceId } = await fixture.startProcess(EMPTY_KEY, {});

    const visited = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'BatchClosed',
    );

    // The whole history of the instance: the end event was reached, the loop
    // around the step was entered and left, and the step itself never ran.
    expect(visited.sort()).toEqual([
      'BatchClosed',
      'BatchOpened',
      'LogEntry#multiInstanceBody',
    ]);
  }, 60_000);
});
