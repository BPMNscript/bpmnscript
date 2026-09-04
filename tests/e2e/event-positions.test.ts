// Three ways of entering a process that no compiled document shows: a message
// correlated with no instance to aim at, a signal broadcast to whatever
// subscribed at deployment, and a timer job parked until something fires it.
// The terminate end is here for the same reason: what separates it from a
// plain end is that it stops a sibling branch still parked on its own task.
// The audit timer is dated 2099, so only the test can fire it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activityIdsIncluding,
  broadcastSignal,
  executeJob,
  historicActivities,
  historicInstances,
  isRunning,
  jobsOf,
  startByMessage,
  waitFor,
  waitForTaskId,
  waitForTaskKeys,
} from '../helpers/engine-rest.js';

describe.skipIf(SKIP)('E2E: start, end and throw triggers on Operaton', () => {
  let fixture: FixtureAdapter;

  // A broadcast names no instance in its response, so the one it created is
  // found by diffing the definition's instance list around the call.
  async function signalStockAlert(): Promise<string> {
    const before = new Set(
      (await historicInstances(fixture, 'stock-alert')).map((i) => i.id),
    );
    await broadcastSignal(fixture, 'StockRunningLow');
    const after = await waitFor(
      () => historicInstances(fixture, 'stock-alert'),
      (list) => list.some((i) => !before.has(i.id)),
    );
    const created = after.find((i) => !before.has(i.id));
    expect(
      created,
      'no stock-alert instance appeared after the broadcast',
    ).toBeDefined();
    return created!.id;
  }

  beforeAll(async () => {
    fixture = await deployExamples(
      'order-intake',
      'stock-alert',
      'scheduled-audit',
    );
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('message start: a correlated message with no instance to aim at starts one', async () => {
    const processInstanceId = await startByMessage(fixture, 'OrderReceived');
    expect(processInstanceId).toBeTruthy();

    expect(
      await waitForTaskKeys(fixture, processInstanceId, (k) =>
        k.includes('ConfirmOrder'),
      ),
    ).toContain('ConfirmOrder');
  }, 60_000);

  // Neither thrown message carries an implementation, so the question the
  // engine answers here is whether it passes the token through both or refuses
  // the definition outright.
  it('message throw and message end: the token passes through both and the instance ends', async () => {
    const processInstanceId = await startByMessage(fixture, 'OrderReceived');
    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ConfirmOrder'),
    );

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderAcknowledged',
    );
    expect(activityIds).toContain('NotifyWarehouse');

    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
  }, 60_000);

  it('signal start: a broadcast starts an instance with both parallel tasks active', async () => {
    const processInstanceId = await signalStockAlert();

    expect(
      await waitForTaskKeys(fixture, processInstanceId, (k) => k.length === 2),
    ).toEqual(['EscalateToBuyer', 'ReorderStock']);
  }, 60_000);

  // A plain end would leave ReorderStock waiting and the instance running.
  it('terminate end: reaching it cancels the sibling branch still parked on a task', async () => {
    const processInstanceId = await signalStockAlert();
    await waitForTaskKeys(fixture, processInstanceId, (k) => k.length === 2);

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'EscalateToBuyer'),
    );

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderAbandoned',
    );
    expect(activityIds).not.toContain('Restocked');

    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
    expect(await fixture.getActiveTasks(processInstanceId)).toEqual([]);

    const reorder = (await historicActivities(fixture, processInstanceId)).find(
      (a) => a.activityId === 'ReorderStock',
    );
    expect(reorder?.canceled).toBe(true);
  }, 60_000);

  it('timer start: the parked job creates the instance only once it is fired', async () => {
    const jobs = await waitFor(
      () => jobsOf(fixture, 'scheduled-audit'),
      (list) => list.length > 0,
    );
    expect(jobs).toHaveLength(1);
    expect(await historicInstances(fixture, 'scheduled-audit')).toEqual([]);

    await executeJob(fixture, jobs[0]!.id);

    const instances = await waitFor(
      () => historicInstances(fixture, 'scheduled-audit'),
      (list) => list.length > 0,
    );
    expect(instances).toHaveLength(1);
    expect(
      await waitForTaskKeys(fixture, instances[0]!.id, (k) =>
        k.includes('ReviewAudit'),
      ),
    ).toContain('ReviewAudit');
  }, 60_000);
});
