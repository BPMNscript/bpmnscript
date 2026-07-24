/**
 * End-to-end integration test — an error boundary on a service task, and a
 * non-gating observation of compensation triggered from inside a
 * process-level error handler, both driven on a running Operaton engine.
 *
 * Structure, layout and XML shape are covered by the unit and health-check
 * suites. What no amount of static checking can show is that an interrupting
 * error boundary attached to a *service* task really does catch a `BpmnError`
 * thrown by that task's delegate — cancelling the host and moving the token
 * onto the escape path — and, separately, whether a `compensate all` thrown
 * from inside an error-handling event-subprocess actually reaches a sibling
 * subprocess's completed undo block on the live engine. Only a real engine
 * decides either, so this suite deploys `charge-with-recovery.bpmnscript` and
 * `compensating-saga.bpmnscript` to Operaton and drives them over the REST
 * API:
 *
 *   1. Build BPMN XML from each DSL source via the real `bpmns` CLI, so the
 *      deployed artifact travels exactly the path a user's would.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy both once, in one container boot, and run each path on its own
 *      process instance.
 *
 * Both examples are driven by a boolean process variable (`failCharge`) read
 * by the shared conditional delegate — never by waiting on a clock or
 * correlating a message.
 *
 * The always-on health assertions for both examples (validator-clean, and
 * the emitted shape each one is meant to demonstrate) live in
 * `tests/service-boundary-and-compensation-example.test.ts`, so this file is
 * Docker-gated in full and is skipped when `SKIP_DOCKER_TESTS=true` (as in
 * CI).
 *
 * The compensation-observation describe below never hard-asserts whether the
 * undo step actually ran: that fact is SUSPECTED, not proven, so a negative
 * outcome must not fail the suite. It is instead surfaced as a single
 * greppable `console.warn` line, so a human (or a later verification pass)
 * can read the outcome without the suite's "0 failed" bar depending on it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixture } from '../fixtures/index.js';
import type { FixtureAdapter } from '../fixtures/index.js';

// ---------------------------------------------------------------------------
// ESM-compatible __dirname
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Skip gate
// ---------------------------------------------------------------------------

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Engine REST helpers
//
// The fixture adapter covers deploy / start / task list / task completion.
// The history query this suite needs is not part of that contract, so it is
// issued directly against `restBaseUrl()`, with the same fail-loudly-on-a-
// non-2xx handling the adapter itself applies.
// ---------------------------------------------------------------------------

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Operaton REST error [${context}]: HTTP ${response.status} — ${body}`,
    );
  }
}

async function engineGet<T>(
  fixture: FixtureAdapter,
  resource: string,
  context: string,
): Promise<T> {
  const response = await fetch(fixture.restBaseUrl() + resource);
  await assertOk(response, context);
  return (await response.json()) as T;
}

interface HistoricActivityInstance {
  activityId: string;
  endTime: string | null;
  canceled: boolean;
}

/** Every activity instance the engine has recorded for a process instance. */
async function historicActivities(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<HistoricActivityInstance[]> {
  return engineGet<HistoricActivityInstance[]>(
    fixture,
    `/engine-rest/history/activity-instance?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `historicActivities(${processInstanceId})`,
  );
}

/**
 * Whether a process instance is still running.
 *
 * Asked of the single-instance resource rather than the collection query: the
 * runtime collection has no `processInstanceId` filter, so a query built on
 * that name silently reports on every other instance the shared engine still
 * holds. `404` here means the instance is gone from the runtime, which for a
 * process that cannot be cancelled from outside means it ran to its end.
 */
async function isRunning(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<boolean> {
  const response = await fetch(
    `${fixture.restBaseUrl()}/engine-rest/process-instance/${encodeURIComponent(processInstanceId)}`,
  );
  if (response.status === 404) {
    return false;
  }
  await assertOk(response, `isRunning(${processInstanceId})`);
  return true;
}

// ---------------------------------------------------------------------------
// Polling
//
// Operaton's REST API is eventually consistent: a completed task or a fired
// event may briefly leave the successor state invisible to a query. Every
// observation below therefore polls until the predicate holds or the timeout
// expires, and asserts on whatever the last poll returned — so a genuine
// mismatch still fails, it just fails after the engine has settled.
// ---------------------------------------------------------------------------

async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  let value = await probe();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await probe();
  }
  return value;
}

function activeTaskKeys(tasks: Array<{ taskDefinitionKey: string }>): string[] {
  return tasks.map((task) => task.taskDefinitionKey).sort();
}

// ---------------------------------------------------------------------------
// Docker-gated E2E suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)(
  'E2E: error-boundary and compensation examples on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    /** Activity ids the engine has recorded, once the given one shows up. */
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

    /** Id of the single active task with the given definition key. */
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

    /**
     * Before all tests:
     *   1. Compile both `.bpmnscript` DSL files → BPMN XML via the real CLI.
     *   2. Boot the Operaton Spring Boot container via testcontainers.
     *   3. Deploy both compiled definitions once, from a single container
     *      boot — every path below starts its own instance from one of the
     *      two deployed process definitions.
     *
     * The 300 s timeout accommodates a cold image build plus Spring Boot
     * startup.
     */
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

    // -----------------------------------------------------------------------
    // Gating: the error boundary on a service task
    // -----------------------------------------------------------------------

    describe('error boundary on the charge service task', () => {
      /**
       * The load-bearing assertion: a delegate `BpmnError` really does fire
       * the boundary, cancel the host service task, and hand the token to
       * the escape path. A misconfigured boundary would surface as an
       * unhandled exception (an HTTP 500 from `startProcess`), so a green
       * test here is itself proof the catch worked, not merely that the
       * process deployed.
       */
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

      /**
       * The control instance: with the failure condition off, the delegate
       * behaves like a plain log-and-continue step, the boundary never
       * fires, and the process runs straight through to its normal end.
       */
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

    // -----------------------------------------------------------------------
    // Non-gating: whether compensation actually fires from inside the
    // process-level error handler.
    // -----------------------------------------------------------------------

    describe('compensation observation (non-gating)', () => {
      /**
       * The compensable subprocess completes, the failing step then raises
       * the process's declared error, and the process-level error handler
       * (lowered to a triggered-by-event subprocess) runs and emits
       * `compensate all`. Whether that emit actually reaches the sibling
       * subprocess's completed undo block is the SUSPECTED fact under
       * observation — everything else here is ordinary setup soundness and
       * is hard-asserted; the outcome itself is only ever printed.
       */
      it('reports whether the undo step ran after the error handler emits compensation', async () => {
        const { processInstanceId } = await fixture.startProcess(
          COMPENSATION_PROCESS_KEY,
          { failCharge: true },
        );

        // Setup soundness — gating.
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

        // The SUSPECTED fact — observed, never asserted.
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
