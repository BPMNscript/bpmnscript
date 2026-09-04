// The runtime property separating the two attachment modes is engine-only: an
// interrupting boundary destroys the token sitting in its host activity, a
// non-interrupting one leaves it alone. Each path runs on its own instance and
// is driven by correlating a message over REST, never by waiting on a clock.
// The process also carries a PT4H timer boundary that stays dormant throughout.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activeTaskKeys,
  activityIdsIncluding,
  correlateMessage,
  historicActivities,
  isRunning,
  waitFor,
  waitForTaskId,
  waitForTaskKeys,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'order-handling';

describe.skipIf(SKIP)('E2E: boundary events on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples('order-handling');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  // The escalation thrown inside the payment sub-process is part of the main
  // narrative: its non-interrupting boundary opens the supervisory review task
  // alongside the continuing flow, and the instance ends once that is done too.
  it('leaves the main flow undisturbed when no boundary message arrives', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ReviewOrder'),
    );

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderShipped',
    );
    expect(activityIds).toContain('AuthorizePayment');
    expect(activityIds).toContain('CapturePayment');
    expect(activityIds).toContain('ShipOrder');

    // No boundary escape path ran: neither message was correlated, and the
    // review timer's four-hour deadline is far outside the run.
    expect(activityIds).not.toContain('MarkAutoApproved');
    expect(activityIds).not.toContain('RecordReviewStatus');
    expect(activityIds).not.toContain('SendReviewReminder');

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ReviewLargePayment'),
    );
    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
  }, 60_000);

  // `cancelActivity="true"` is the default, written without `alongside`: the
  // engine must destroy the token in the host task, so the task leaves the task
  // list and its activity instance is recorded as canceled.
  it('interrupting boundary: correlating the message cancels the host task', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await waitForTaskId(fixture, processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'AutoApproved', processInstanceId);

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'MarkAutoApproved',
    );
    expect(activityIds).toContain('Boundary_ReviewOrder_message');

    const keys = await waitForTaskKeys(
      fixture,
      processInstanceId,
      (k) => !k.includes('ReviewOrder'),
    );
    expect(keys).not.toContain('ReviewOrder');

    const review = (await historicActivities(fixture, processInstanceId)).find(
      (a) => a.activityId === 'ReviewOrder',
    );
    expect(review?.canceled).toBe(true);
  }, 60_000);

  // `alongside` serializes as `cancelActivity="false"`: the escape path runs and
  // the review task keeps waiting, two states that have to hold at the same
  // moment.
  it('non-interrupting boundary: the host task survives its own boundary event', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await waitForTaskId(fixture, processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'SupervisorPing', processInstanceId);

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'RecordReviewStatus',
    );
    expect(activityIds).toContain('Boundary_ReviewOrder_message_2');

    const activities = await historicActivities(fixture, processInstanceId);
    const review = activities.find((a) => a.activityId === 'ReviewOrder');
    expect(review?.canceled).toBe(false);
    expect(review?.endTime).toBeNull();
    const stillWaiting = activeTaskKeys(
      await fixture.getActiveTasks(processInstanceId),
    );
    expect(stillWaiting).toContain('ReviewOrder');

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ReviewOrder'),
    );
    expect(
      await activityIdsIncluding(fixture, processInstanceId, 'OrderShipped'),
    ).toContain('ShipOrder');
  }, 60_000);

  // `goto` is the only way an escape path rejoins the main flow. Driving it on
  // the engine proves the rejoin is real flow, not a decompiler-only construct.
  it('the escape path rejoins the main flow through goto and runs to the end', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await waitForTaskId(fixture, processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'AutoApproved', processInstanceId);

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderShipped',
    );
    expect(activityIds).toContain('MarkAutoApproved');
    expect(activityIds).toContain('Payment');
    expect(activityIds).toContain('AuthorizePayment');
    expect(activityIds).toContain('CapturePayment');
    expect(activityIds).toContain('ShipOrder');

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ReviewLargePayment'),
    );
    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
  }, 60_000);
});
