// A compiled document cannot show the property that makes `await` a wait: that
// a real engine parks the token there until the message arrives instead of
// falling through. So this proves over REST that the instance is blocked at the
// catch, still running with an active message subscription, before correlating
// the message and watching it finish.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  correlateMessage,
  eventSubscriptions,
  historicActivities,
  isRunning,
  waitFor,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'awaiting-confirmation';

const MESSAGE_NAME = 'ConfirmationReceived';

describe.skipIf(SKIP)('E2E: await message on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples('awaiting-confirmation');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('blocks at the message catch until the message is correlated, then completes', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    // The active subscription is what proves the token is parked at the catch
    // specifically, rather than somewhere before the end for another reason.
    const subscriptionsBefore = await waitFor(
      () => eventSubscriptions(fixture, processInstanceId),
      (subs) => subs.some((s) => s.eventName === MESSAGE_NAME),
    );
    expect(subscriptionsBefore).toHaveLength(1);
    expect(subscriptionsBefore[0]!.eventType).toBe('message');
    expect(subscriptionsBefore[0]!.eventName).toBe(MESSAGE_NAME);

    expect(await isRunning(fixture, processInstanceId)).toBe(true);
    const activitiesBefore = await historicActivities(
      fixture,
      processInstanceId,
    );
    expect(activitiesBefore.map((a) => a.activityId)).toContain(
      'SubmitRequest',
    );
    expect(activitiesBefore.map((a) => a.activityId)).not.toContain(
      'FinalizeRequest',
    );

    await correlateMessage(fixture, MESSAGE_NAME, processInstanceId);

    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);

    const activitiesAfter = await historicActivities(
      fixture,
      processInstanceId,
    );
    const ranActivities = activitiesAfter.map((a) => a.activityId);
    expect(ranActivities).toContain('SubmitRequest');
    expect(ranActivities).toContain('FinalizeRequest');
    expect(ranActivities).toContain('RequestCompleted');
  }, 60_000);
});
