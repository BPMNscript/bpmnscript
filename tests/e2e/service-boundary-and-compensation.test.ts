// Only a real engine decides whether an interrupting error boundary on a
// service task catches the `BpmnError` its delegate throws, cancels the host,
// and moves the token onto the escape path. Each path is steered by a boolean
// process variable the shared conditional delegate reads, never by a clock or a
// correlated message.
//
// The compensation half covers the other route into the undo machinery: an
// `emit compensation` raised by the process-level error handler has to reach
// the undo block of a subprocess that already completed.

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
  historicActivities,
  isRunning,
  waitFor,
  waitForTaskId,
} from '../helpers/engine-rest.js';

const CHARGE_PROCESS_KEY = 'charge-with-recovery';

const COMPENSATION_PROCESS_KEY = 'compensating-saga';

describe.skipIf(SKIP)(
  'E2E: error-boundary and compensation examples on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    // Both examples are deployed into one container boot.
    beforeAll(async () => {
      fixture = await deployExamples(
        CHARGE_PROCESS_KEY,
        COMPENSATION_PROCESS_KEY,
      );
    }, ENGINE_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await fixture?.stop();
    });

    describe('error boundary on the charge service task', () => {
      // A misconfigured boundary surfaces as an HTTP 500 from startProcess, so
      // getting this far already proves the catch worked.
      it('catches the delegate error, cancels the host, and completes through the escape task', async () => {
        const { processInstanceId } = await fixture.startProcess(
          CHARGE_PROCESS_KEY,
          { failCharge: true },
        );

        const activityIds = await activityIdsIncluding(
          fixture,
          processInstanceId,
          'Boundary_ChargeCard_error',
        );
        expect(activityIds).toContain('Boundary_ChargeCard_error');

        const activities = await historicActivities(fixture, processInstanceId);
        const chargeCard = activities.find(
          (a) => a.activityId === 'ChargeCard',
        );
        expect(chargeCard?.canceled).toBe(true);

        const stillActive = activeTaskKeys(
          await fixture.getActiveTasks(processInstanceId),
        );
        expect(stillActive).toContain('ReviewFailedCharge');

        await fixture.completeTask(
          await waitForTaskId(fixture, processInstanceId, 'ReviewFailedCharge'),
        );

        expect(
          await waitFor(
            () => isRunning(fixture, processInstanceId),
            (running) => !running,
          ),
        ).toBe(false);
      }, 60_000);

      it('runs the charge through to the normal end when the failure condition is off', async () => {
        const { processInstanceId } = await fixture.startProcess(
          CHARGE_PROCESS_KEY,
          { failCharge: false },
        );

        const activityIds = await activityIdsIncluding(
          fixture,
          processInstanceId,
          'OrderCharged',
        );
        expect(activityIds).toContain('ChargeCard');
        expect(activityIds).toContain('ConfirmCharge');
        expect(activityIds).not.toContain('Boundary_ChargeCard_error');
        expect(activityIds).not.toContain('ReviewFailedCharge');

        const chargeCard = (
          await historicActivities(fixture, processInstanceId)
        ).find((a) => a.activityId === 'ChargeCard');
        expect(chargeCard?.canceled).toBe(false);

        expect(
          await waitFor(
            () => isRunning(fixture, processInstanceId),
            (running) => !running,
          ),
        ).toBe(false);
      }, 60_000);
    });

    describe('compensation raised by the error handler', () => {
      // The undo block belongs to a subprocess that completed before the charge
      // failed, so reaching it means the emit crossed a container boundary and
      // found a step already behind the token.
      it('runs the completed subprocess undo block when the error handler emits compensation', async () => {
        const { processInstanceId } = await fixture.startProcess(
          COMPENSATION_PROCESS_KEY,
          { failCharge: true },
        );

        const activityIds = await activityIdsIncluding(
          fixture,
          processInstanceId,
          'ReleaseSeat',
        );
        expect(activityIds).toContain('ReserveSeatTask');
        expect(activityIds).toContain('ChargeCard');
        expect(activityIds).toContain('CompensationTriggered');
        expect(activityIds).toContain('ReleaseSeat');

        expect(
          await waitFor(
            () => isRunning(fixture, processInstanceId),
            (running) => !running,
          ),
        ).toBe(false);
      }, 60_000);
    });
  },
);
