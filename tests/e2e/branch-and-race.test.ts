import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  correlateMessage,
  engineGet,
  eventSubscriptions,
  historicActivities,
  waitFor,
  waitForTaskId,
  waitForTaskKeys,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'order-dispatch';

const MESSAGE_NAME = 'DispatchConfirmed';

// Every gateway and catch event here carries a synthesized id, and history
// names an activity by id, so the history assertions have to know them.
const RACE_GATEWAY = 'Gateway_order-dispatch_2_race';
const MESSAGE_CATCH = 'Catch_order-dispatch_2_b0';
const FORK_GATEWAY = 'Gateway_order-dispatch_1_fork';
const JOIN_GATEWAY = 'Gateway_order-dispatch_1_join';

// One engine serves every instance this file starts, so a job query keyed on
// the definition would count the timers of the other tests too.
async function jobsOfInstance(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<Array<{ id: string }>> {
  return engineGet<Array<{ id: string }>>(
    fixture,
    `/engine-rest/job?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `jobsOfInstance(${processInstanceId})`,
  );
}

describe.skipIf(SKIP)(
  'E2E: an inclusive fork and a race on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    beforeAll(async () => {
      fixture = await deployExamples(PROCESS_KEY);
    }, ENGINE_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await fixture?.stop();
    });

    // Starts an instance and walks it past the fork, so the race assertions
    // begin from a token sitting at the event-based gateway.
    async function reachRace(): Promise<string> {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        amount: 100,
      });
      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Record'),
      );
      await waitFor(
        () => eventSubscriptions(fixture, processInstanceId),
        (subs) => subs.length > 0,
      );
      return processInstanceId;
    }

    it('deploys, so the engine parser accepts both gateway tags as they are written', async () => {
      const definitions = await engineGet<Array<{ key: string }>>(
        fixture,
        `/engine-rest/process-definition?key=${encodeURIComponent(PROCESS_KEY)}`,
        `processDefinitions(${PROCESS_KEY})`,
      );
      expect(definitions.map((definition) => definition.key)).toContain(
        PROCESS_KEY,
      );
    }, 60_000);

    it('opens one task when one condition holds, and the join waits for that branch alone', async () => {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        amount: 100,
      });

      expect(
        await waitForTaskKeys(
          fixture,
          processInstanceId,
          (keys) => keys.length > 0,
        ),
      ).toEqual(['Record']);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Record'),
      );

      const subscriptions = await waitFor(
        () => eventSubscriptions(fixture, processInstanceId),
        (subs) => subs.length > 0,
      );
      expect(subscriptions).toHaveLength(1);
      expect(await jobsOfInstance(fixture, processInstanceId)).toHaveLength(1);
      expect(await fixture.getActiveTasks(processInstanceId)).toEqual([]);
    }, 60_000);

    it('opens two tasks when both conditions hold, and holds the token until both are done', async () => {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        amount: 50000,
      });

      expect(
        await waitForTaskKeys(
          fixture,
          processInstanceId,
          (keys) => keys.length >= 2,
        ),
      ).toEqual(['Audit', 'Record']);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Audit'),
      );

      expect(
        await waitForTaskKeys(
          fixture,
          processInstanceId,
          (keys) => keys.length <= 1,
        ),
      ).toEqual(['Record']);
      expect(await eventSubscriptions(fixture, processInstanceId)).toEqual([]);
      expect(await jobsOfInstance(fixture, processInstanceId)).toEqual([]);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Record'),
      );

      expect(
        await waitFor(
          () => eventSubscriptions(fixture, processInstanceId),
          (subs) => subs.length > 0,
        ),
      ).toHaveLength(1);
      expect(await jobsOfInstance(fixture, processInstanceId)).toHaveLength(1);
    }, 60_000);

    it('falls back to the branch the source never wires when no condition holds', async () => {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        amount: 0,
      });

      expect(
        await waitForTaskKeys(
          fixture,
          processInstanceId,
          (keys) => keys.length > 0,
        ),
      ).toEqual(['Triage']);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Triage'),
      );

      expect(
        await waitFor(
          () => eventSubscriptions(fixture, processInstanceId),
          (subs) => subs.length > 0,
        ),
      ).toHaveLength(1);
    }, 60_000);

    it('lets exactly one branch of the race win and cancels the trigger the loser waited on', async () => {
      const processInstanceId = await reachRace();

      const subscriptions = await eventSubscriptions(
        fixture,
        processInstanceId,
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({
        activityId: MESSAGE_CATCH,
        eventType: 'message',
        eventName: MESSAGE_NAME,
      });
      expect(await jobsOfInstance(fixture, processInstanceId)).toHaveLength(1);

      await correlateMessage(fixture, MESSAGE_NAME, processInstanceId);

      expect(
        await waitForTaskKeys(
          fixture,
          processInstanceId,
          (keys) => keys.length > 0,
        ),
      ).toEqual(['Handover']);
      expect(
        await waitFor(
          () => jobsOfInstance(fixture, processInstanceId),
          (jobs) => jobs.length === 0,
        ),
      ).toEqual([]);

      // A branch waits as a subscription and a job held by the gateway, not as
      // an activity instance of its own, so the cancellation lands on the
      // gateway: it is the event scope the winning branch tears down. The
      // losing catch event never starts, and history never names it.
      const activities = await waitFor(
        () => historicActivities(fixture, processInstanceId),
        (list) =>
          list.some(
            (activity) =>
              activity.activityId === MESSAGE_CATCH &&
              activity.endTime !== null,
          ),
      );
      // Everything the run reached, so a step that should not have run and an
      // id that drifted both surface here rather than through a filter that
      // finds nothing either way.
      expect([...new Set(activities.map((a) => a.activityId))].sort()).toEqual([
        MESSAGE_CATCH,
        FORK_GATEWAY,
        JOIN_GATEWAY,
        RACE_GATEWAY,
        'Handover',
        'OrderReceived',
        'Record',
      ]);
      expect(
        activities.filter((activity) => activity.activityId === RACE_GATEWAY),
      ).toMatchObject([{ canceled: true }]);
      expect(
        activities.filter((activity) => activity.activityId === MESSAGE_CATCH),
      ).toMatchObject([{ canceled: false }]);
    }, 60_000);
  },
);
