/**
 * Boundary events on a running engine.
 *
 * Static checking cannot show the runtime property that separates the two
 * attachment modes: an interrupting boundary event destroys the token sitting in
 * its host activity, a non-interrupting one leaves it alone. Only a real engine
 * decides that, so this suite builds the example with the real `bpmns` CLI,
 * boots Operaton via testcontainers, deploys it once, and runs each path on its
 * own instance. Both boundaries under test are driven by correlating a message
 * over REST, never by waiting on a clock; the process also carries a `PT4H`
 * timer boundary, which stays dormant for the whole run.
 *
 * The whole file is Docker-gated and skipped when `SKIP_DOCKER_TESTS=true`; the
 * always-on health assertions for the example live in a separate suite.
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
  correlateMessage,
  historicActivities,
  isRunning,
  waitFor,
} from '../helpers/engine-rest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true';

const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/order-handling.bpmnscript',
);

const XML_OUT_PATH = path.resolve(__dirname, '../../out/order-handling.bpmn');

const PROCESS_KEY = 'order-handling';

describe.skipIf(SKIP)('E2E: boundary events on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  async function tasksOf(
    processInstanceId: string,
    predicate: (keys: string[]) => boolean,
  ): Promise<string[]> {
    const tasks = await waitFor(
      () => fixture.getActiveTasks(processInstanceId),
      (t) => predicate(activeTaskKeys(t)),
    );
    return activeTaskKeys(tasks);
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

  // The 300 s timeout accommodates a cold image build plus Spring Boot startup.
  beforeAll(async () => {
    mkdirSync(path.dirname(XML_OUT_PATH), { recursive: true });

    execFileSync('npx', ['bpmns', 'build', DSL_PATH, '-o', XML_OUT_PATH], {
      stdio: 'inherit',
    });

    fixture = await startFixture('spring-boot');

    const { deploymentId } = await fixture.deploy(
      XML_OUT_PATH,
      'boundary-events-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  // The escalation thrown inside the payment sub-process is part of the main
  // narrative: its non-interrupting boundary opens the supervisory review task
  // alongside the continuing flow, and the instance ends once that is done too.
  it('leaves the main flow undisturbed when no boundary message arrives', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    await fixture.completeTask(await taskId(processInstanceId, 'ReviewOrder'));

    const activityIds = await activityIdsIncluding(
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
      await taskId(processInstanceId, 'ReviewLargePayment'),
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
    await taskId(processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'AutoApproved', processInstanceId);

    const activityIds = await activityIdsIncluding(
      processInstanceId,
      'MarkAutoApproved',
    );
    expect(activityIds).toContain('Boundary_ReviewOrder_message');

    const keys = await tasksOf(
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
    await taskId(processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'SupervisorPing', processInstanceId);

    const activityIds = await activityIdsIncluding(
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

    // The surviving token still drives the main flow when it completes.
    await fixture.completeTask(await taskId(processInstanceId, 'ReviewOrder'));
    expect(
      await activityIdsIncluding(processInstanceId, 'OrderShipped'),
    ).toContain('ShipOrder');
  }, 60_000);

  // `goto` is the only way an escape path rejoins the main flow. Driving it on
  // the engine proves the rejoin is real flow, not a decompiler-only construct.
  it('the escape path rejoins the main flow through goto and runs to the end', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await taskId(processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'AutoApproved', processInstanceId);

    const activityIds = await activityIdsIncluding(
      processInstanceId,
      'OrderShipped',
    );
    expect(activityIds).toContain('MarkAutoApproved');
    expect(activityIds).toContain('Payment');
    expect(activityIds).toContain('AuthorizePayment');
    expect(activityIds).toContain('CapturePayment');
    expect(activityIds).toContain('ShipOrder');

    await fixture.completeTask(
      await taskId(processInstanceId, 'ReviewLargePayment'),
    );
    expect(
      await waitFor(
        () => isRunning(fixture, processInstanceId),
        (running) => !running,
      ),
    ).toBe(false);
  }, 60_000);
});
