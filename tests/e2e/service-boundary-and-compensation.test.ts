// Only a real engine decides whether an interrupting error boundary on a
// service task catches the `BpmnError` its delegate throws, cancels the host,
// and moves the token onto the escape path. Each path is steered by a boolean
// process variable the shared conditional delegate reads, never by a clock or a
// correlated message.
//
// The compensation half never hard-asserts whether the undo step ran: that fact
// is suspected, not proven, so it is printed as one greppable console.warn
// rather than failing the suite.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activeTaskKeys,
  historicActivities,
  isRunning,
  waitFor,
} from '../helpers/engine-rest.js';

const CHARGE_PROCESS_KEY = 'charge-with-recovery';

const COMPENSATION_PROCESS_KEY = 'compensating-saga';

describe.skipIf(SKIP)(
  'E2E: error-boundary and compensation examples on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    async function activityIdsIncluding(
      processInstanceId: string,
      activityId: string,
    ): Promise<string[]> {
      const activities = await waitFor(
        () => historicActivities(fixture, processInstanceId),
        (list) => list.some((a) => a.activityId === activityId),
      );
      return activities.map((a) => a.activityId);
    }

    async function taskId(
      processInstanceId: string,
      definitionKey: string,
    ): Promise<string> {
      const tasks = await waitFor(
        () => fixture.getActiveTasks(processInstanceId),
        (t) => t.some((task) => task.taskDefinitionKey === definitionKey),
      );
      const match = tasks.find(
        (task) => task.taskDefinitionKey === definitionKey,
      );
      expect(
        match,
        `no active task '${definitionKey}' in instance ${processInstanceId}`,
      ).toBeDefined();
      return match!.id;
    }

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
          await taskId(processInstanceId, 'ReviewFailedCharge'),
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

    describe('compensation observation (non-gating)', () => {
      // Whether the error handler's `compensate all` reaches the sibling
      // subprocess's completed undo block is the suspected fact. The setup is
      // hard-asserted; the outcome is only printed.
      it('reports whether the undo step ran after the error handler emits compensation', async () => {
        const { processInstanceId } = await fixture.startProcess(
          COMPENSATION_PROCESS_KEY,
          { failCharge: true },
        );

        // Setup soundness, gating.
        const activityIds = await activityIdsIncluding(
          processInstanceId,
          'CompensationTriggered',
        );
        expect(activityIds).toContain('ReserveSeatTask');
        expect(activityIds).toContain('ChargeCard');
        expect(activityIds).toContain('CompensationTriggered');

        expect(
          await waitFor(
            () => isRunning(fixture, processInstanceId),
            (running) => !running,
          ),
        ).toBe(false);

        // The suspected fact: observed, never asserted.
        const finalActivities = await historicActivities(
          fixture,
          processInstanceId,
        );
        const compensationRan = finalActivities.some(
          (a) => a.activityId === 'ReleaseSeat',
        );
        console.warn(
          `compensation-observation: undo handler ran = ${compensationRan}`,
        );
      }, 60_000);
    });
  },
);
