/**
 * An error boundary on a service task, and a non-gating observation of
 * compensation triggered from inside a process-level error handler, both driven
 * on a running Operaton engine.
 *
 * Static checking cannot show that an interrupting error boundary on a service
 * task really catches a `BpmnError` thrown by that task's delegate, cancels the
 * host, and moves the token onto the escape path, nor whether a `compensate all`
 * thrown from inside an error-handling event-subprocess reaches a sibling
 * subprocess's completed undo block. Only a real engine decides either, so this
 * suite builds both examples with the real `bpmns` CLI, boots Operaton via
 * testcontainers, deploys both in one container boot, and drives them over the
 * REST API. Each path is steered by a boolean process variable read by the
 * shared conditional delegate, never by waiting on a clock or correlating a
 * message.
 *
 * The whole file is Docker-gated and skipped when `SKIP_DOCKER_TESTS=true`; the
 * always-on health assertions for both examples live in a separate suite.
 *
 * The compensation observation never hard-asserts whether the undo step ran:
 * that fact is suspected, not proven, so a negative outcome must not fail the
 * suite. It is surfaced as one greppable `console.warn` line instead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixture } from '../fixtures/index.js';
import type { FixtureAdapter } from '../fixtures/index.js';
import {
  activeTaskKeys,
  historicActivities,
  isRunning,
  waitFor,
} from '../helpers/engine-rest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true';

const CHARGE_DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/charge-with-recovery.bpmnscript',
);
const CHARGE_XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/charge-with-recovery.bpmn',
);
const CHARGE_PROCESS_KEY = 'charge-with-recovery';

const COMPENSATION_DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/compensating-saga.bpmnscript',
);
const COMPENSATION_XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/compensating-saga.bpmn',
);
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

    // The 300 s timeout accommodates a cold image build plus Spring Boot startup.
    beforeAll(async () => {
      mkdirSync(path.dirname(CHARGE_XML_OUT_PATH), { recursive: true });

      execFileSync(
        'npx',
        ['bpmns', 'build', CHARGE_DSL_PATH, '-o', CHARGE_XML_OUT_PATH],
        { stdio: 'inherit' },
      );
      execFileSync(
        'npx',
        [
          'bpmns',
          'build',
          COMPENSATION_DSL_PATH,
          '-o',
          COMPENSATION_XML_OUT_PATH,
        ],
        { stdio: 'inherit' },
      );

      fixture = await startFixture('spring-boot');

      const chargeDeployment = await fixture.deploy(
        CHARGE_XML_OUT_PATH,
        'charge-with-recovery-test',
      );
      expect(chargeDeployment.deploymentId).toBeTruthy();

      const compensationDeployment = await fixture.deploy(
        COMPENSATION_XML_OUT_PATH,
        'compensating-saga-test',
      );
      expect(compensationDeployment.deploymentId).toBeTruthy();
    }, 300_000);

    afterAll(async () => {
      await fixture?.stop();
    });

    describe('error boundary on the charge service task', () => {
      // A misconfigured boundary would surface as an unhandled exception (an
      // HTTP 500 from `startProcess`), so passing here is itself proof the catch
      // worked, not merely that the process deployed.
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
      // Whether the `compensate all` the error handler emits reaches the
      // sibling subprocess's completed undo block is the suspected fact under
      // observation. The setup around it is hard-asserted; the outcome is only
      // printed.
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
