import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import type { HistoricActivityInstance } from '../helpers/engine-rest.js';
import {
  activeTaskKeys,
  activityIdsIncluding,
  historicActivities,
  waitFor,
  waitForTaskId,
  waitUntilFinished,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'booking-attempt';

const BLOCK = 'BookAndPay';

const CANCEL_BOUNDARY = 'Boundary_BookAndPay_cancel';

describe.skipIf(SKIP)(
  'E2E: giving up a block of work on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    beforeAll(async () => {
      fixture = await deployExamples(PROCESS_KEY);
    }, ENGINE_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await fixture?.stop();
    });

    // Starts one booking and reads its history once `marker` has been recorded,
    // so every assertion below reads a run that reached at least that far.
    async function bookUntil(
      chargeDeclined: boolean,
      marker: string,
    ): Promise<{ processInstanceId: string; activityIds: string[] }> {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        chargeDeclined,
      });
      const activityIds = await activityIdsIncluding(
        fixture,
        processInstanceId,
        marker,
      );
      return { processInstanceId, activityIds };
    }

    // The block's own history entry, read once it satisfies `settled`.
    async function blockInstance(
      processInstanceId: string,
      settled: (activity: HistoricActivityInstance) => boolean,
    ): Promise<HistoricActivityInstance | undefined> {
      return waitFor(
        async () =>
          (await historicActivities(fixture, processInstanceId)).find(
            (activity) => activity.activityId === BLOCK,
          ),
        (activity) => activity !== undefined && settled(activity),
      );
    }

    it('carries the booking past the block when the charge goes through', async () => {
      const { processInstanceId, activityIds } = await bookUntil(
        false,
        'ConfirmBooking',
      );

      expect(activityIds).toContain('HoldSeatTask');
      expect(activityIds).toContain('ChargeCard');
      expect(activityIds).toContain('IssueTicket');
      expect(activityIds).toContain('ConfirmBooking');
      expect(activityIds).not.toContain('BookingAbandoned');
      expect(activityIds).not.toContain(CANCEL_BOUNDARY);
      expect(activityIds).not.toContain('ReleaseSeat');

      expect(
        activeTaskKeys(await fixture.getActiveTasks(processInstanceId)),
      ).toContain('ConfirmBooking');
    }, 60_000);

    it('leaves through the cancel handler and skips the rest of the block when the charge is declined', async () => {
      const { processInstanceId, activityIds } = await bookUntil(
        true,
        'ApologizeToTraveler',
      );

      expect(activityIds).toContain('HoldSeatTask');
      expect(activityIds).toContain('ChargeCard');
      expect(activityIds).toContain('BookingAbandoned');
      expect(activityIds).toContain(CANCEL_BOUNDARY);
      expect(activityIds).toContain('ApologizeToTraveler');
      expect(activityIds).not.toContain('IssueTicket');
      expect(activityIds).not.toContain('ConfirmBooking');

      const openTasks = activeTaskKeys(
        await fixture.getActiveTasks(processInstanceId),
      );
      expect(openTasks).toContain('ApologizeToTraveler');
      expect(openTasks).not.toContain('ConfirmBooking');
    }, 60_000);

    it('undoes the finished step inside the block on the run that gave it up', async () => {
      const { processInstanceId, activityIds } = await bookUntil(
        true,
        'ApologizeToTraveler',
      );

      expect(activityIds).toContain('ApologizeToTraveler');
      expect(activityIds).toContain('HoldSeat');
      expect(activityIds).toContain('ReleaseSeat');

      const undo = (await historicActivities(fixture, processInstanceId)).find(
        (activity) => activity.activityId === 'ReleaseSeat',
      );
      expect(undo?.endTime).toEqual(expect.any(String));
      expect(undo?.canceled).toBe(false);
    }, 60_000);

    it('records the block as canceled only on the run that gave it up', async () => {
      const declined = await bookUntil(true, 'ApologizeToTraveler');
      const givenUp = await blockInstance(
        declined.processInstanceId,
        (activity) => activity.canceled,
      );
      expect(givenUp?.canceled).toBe(true);

      const charged = await bookUntil(false, 'ConfirmBooking');
      const completed = await blockInstance(
        charged.processInstanceId,
        (activity) => activity.endTime !== null,
      );
      expect(completed?.endTime).toEqual(expect.any(String));
      expect(completed?.canceled).toBe(false);
    }, 60_000);

    it('ends the booking once the escape task is done', async () => {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
        chargeDeclined: true,
      });

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'ApologizeToTraveler'),
      );

      expect(
        await activityIdsIncluding(
          fixture,
          processInstanceId,
          'BookingCancelled',
        ),
      ).toContain('BookingCancelled');
      expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
    }, 60_000);
  },
);
