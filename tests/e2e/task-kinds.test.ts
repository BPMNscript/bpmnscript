import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activityIdsIncluding,
  correlateMessage,
  engineGet,
  eventSubscriptions,
  historicActivities,
  isRunning,
  waitFor,
  waitForTaskId,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'task-kinds';

const MESSAGE_NAME = 'ShipmentDispatched';

const PASS_THROUGH_IDS = ['RecordIntent', 'NotifyWarehouse', 'RateOrder'];

describe.skipIf(SKIP)('E2E: task kinds on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(PROCESS_KEY);
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('deploys, so the engine parser accepts every tag as it is written', async () => {
    const definitions = await engineGet<Array<{ key: string }>>(
      fixture,
      `/engine-rest/process-definition?key=${encodeURIComponent(PROCESS_KEY)}`,
      `processDefinitions(${PROCESS_KEY})`,
    );
    expect(definitions.map((definition) => definition.key)).toContain(
      PROCESS_KEY,
    );
  }, 60_000);

  it('walks the token past the step, the send and the decision in one go', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    const activities = await waitFor(
      () => historicActivities(fixture, processInstanceId),
      (list) => list.some((a) => a.activityId === 'AwaitShipment'),
    );
    for (const id of PASS_THROUGH_IDS) {
      expect(
        activities.find((activity) => activity.activityId === id)?.endTime,
        `${id} did not finish`,
      ).toEqual(expect.any(String));
    }
  }, 60_000);

  it('waits at the receive task, subscribed to its message and offering no work', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    const subscriptions = await waitFor(
      () => eventSubscriptions(fixture, processInstanceId),
      (subs) => subs.length > 0,
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      activityId: 'AwaitShipment',
      eventType: 'message',
      eventName: MESSAGE_NAME,
    });

    expect(await isRunning(fixture, processInstanceId)).toBe(true);
    expect(await fixture.getActiveTasks(processInstanceId)).toEqual([]);
  }, 60_000);

  it('releases the receive task on correlation and runs on to the end', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await waitFor(
      () => eventSubscriptions(fixture, processInstanceId),
      (subs) => subs.some((sub) => sub.eventName === MESSAGE_NAME),
    );

    await correlateMessage(fixture, MESSAGE_NAME, processInstanceId);

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ConfirmDelivery'),
    );

    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
    expect(
      await activityIdsIncluding(fixture, processInstanceId, 'OrderClosed'),
    ).toContain('OrderClosed');
  }, 60_000);
});
