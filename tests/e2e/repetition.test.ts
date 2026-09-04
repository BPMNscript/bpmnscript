import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { ActiveTask, FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activityIdsIncluding,
  engineGet,
  historicActivities,
  waitForTaskKeys,
  waitForTasks,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'batch-approval';

const EMPTY_KEY = 'empty-batch';

describe.skipIf(SKIP)('E2E: repetition on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(PROCESS_KEY, EMPTY_KEY);
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  // The open tasks of one activity, once the engine has offered at least `count`
  // of them.
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

  // Completes every open run of an activity, which is what a parallel
  // repetition offers all at once.
  async function completeAll(
    instanceId: string,
    key: string,
    count: number,
  ): Promise<void> {
    for (const task of await tasksOf(instanceId, key, count)) {
      await fixture.completeTask(task.id);
    }
  }

  // Completes `runs` runs of an activity one at a time, checking on every run
  // that the engine offered exactly one, and returning the task id each run was
  // offered under.
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

  // The list entry bound to one run, read off the execution the task hangs on.
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

  // Walks a fresh instance to the tasks the review sub-process opens, so every
  // assertion past the first two starts from the same known point.
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
