/**
 * End-to-end integration test — boundary events on a running engine.
 *
 * Structure, layout and XML shape are covered by the unit and round-trip
 * suites. What no amount of static checking can show is the one runtime
 * property that separates the two attachment modes: an interrupting boundary
 * event destroys the token sitting in its host activity, a non-interrupting
 * one leaves it alone. Only a real engine decides that, so this suite deploys
 * `order-handling.bpmnscript` to Operaton and drives it over the REST API:
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI, so the
 *      deployed artifact travels exactly the path a user's would.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy once and run each path on its own process instance.
 *
 * Both boundaries under test are driven by correlating a message over REST,
 * never by waiting on a clock — the process also carries a `PT4H` timer
 * boundary, which stays dormant for the whole run.
 *
 * The always-on health assertions for this example (validator-clean, and the
 * `attachedToRef`/`cancelActivity` pinning of every boundary it declares) live
 * in `tests/order-handling-example.test.ts`, so this file is Docker-gated in
 * full and is skipped when `SKIP_DOCKER_TESTS=true` (as in CI).
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

/** The deployable example carrying the boundary-event walkthrough. */
const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/order-handling.bpmnscript',
);

/** Generated BPMN XML, written into the git-ignored `out/` directory. */
const XML_OUT_PATH = path.resolve(__dirname, '../../out/order-handling.bpmn');

/** `processDefinitionKey` of the deployed process. */
const PROCESS_KEY = 'order-handling';

// ---------------------------------------------------------------------------
// Engine REST helpers
//
// The fixture adapter covers deploy / start / task list / task completion.
// Message correlation and the history query this suite needs are not part of
// that contract, so they are issued directly against `restBaseUrl()`, with the
// same fail-loudly-on-a-non-2xx handling the adapter itself applies.
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

/**
 * Correlate a message to the one running instance named, delivering it to
 * whichever message event subscription that instance currently holds — for
 * this process, always a boundary event on the review task.
 */
async function correlateMessage(
  fixture: FixtureAdapter,
  messageName: string,
  processInstanceId: string,
): Promise<void> {
  const response = await fetch(fixture.restBaseUrl() + '/engine-rest/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageName, processInstanceId }),
  });
  await assertOk(response, `correlateMessage(${messageName})`);
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
// Operaton's REST API is eventually consistent: a correlated message or a
// completed task may briefly leave the successor state invisible to a query.
// Every observation below therefore polls until the predicate holds or the
// timeout expires, and asserts on whatever the last poll returned — so a
// genuine mismatch still fails, it just fails after the engine has settled.
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

describe.skipIf(SKIP)('E2E: boundary events on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  /** Active user-task definition keys of an instance, once the engine settles. */
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

  /**
   * Before all tests:
   *   1. Compile the `.bpmnscript` DSL → BPMN XML via the real CLI binary.
   *   2. Boot the Operaton Spring Boot container via testcontainers.
   *   3. Deploy the compiled BPMN once — every path below starts its own
   *      instance from the same process definition.
   *
   * The 300 s timeout accommodates a cold image build plus Spring Boot startup.
   */
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

  /**
   * Completing the review task normally leaves both message boundaries
   * unfired and carries the instance along the main flow to its end event.
   * The escalation thrown inside the payment sub-process is part of that main
   * narrative — its non-interrupting boundary opens the supervisory review
   * task alongside the continuing flow, and the instance ends once that task
   * is done too.
   */
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

  /**
   * The load-bearing assertion for `cancelActivity="true"` — the default,
   * written without `alongside`. Correlating `AutoApproved` fires the
   * interrupting boundary on the review task: the engine must destroy the
   * token sitting in that task, so the task disappears from the task list and
   * the engine records its activity instance as canceled, while the escape
   * path's own activity runs.
   */
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

  /**
   * The counterpart assertion for `alongside`, which serializes as
   * `cancelActivity="false"`. Correlating `SupervisorPing` runs the escape
   * path *and* leaves the review task waiting — the two states have to hold at
   * the same moment, which is precisely what distinguishes a non-interrupting
   * boundary from an interrupting one.
   */
  it('non-interrupting boundary: the host task survives its own boundary event', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
    await taskId(processInstanceId, 'ReviewOrder');

    await correlateMessage(fixture, 'SupervisorPing', processInstanceId);

    // The escape path ran to its own end event...
    const activityIds = await activityIdsIncluding(
      processInstanceId,
      'RecordReviewStatus',
    );
    expect(activityIds).toContain('Boundary_ReviewOrder_message_2');

    // ...and the host task is still waiting at the same time.
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

  /**
   * `goto` is the only way an escape path rejoins the main flow, and the
   * interrupting escape path here uses it to jump into the payment
   * sub-process. Driving that path through proves the rejoin is real flow and
   * not a decompiler-only construct: the sub-process runs, the main flow
   * continues past it, and the instance reaches its end event.
   */
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
