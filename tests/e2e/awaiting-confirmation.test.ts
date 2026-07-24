/**
 * End-to-end integration test — the `await message` intermediate catch on a
 * running engine.
 *
 * Every other layer (parse, validate, lower, emit) is covered by unit and
 * round-trip suites, and those can only show that the compiled BPMN *looks*
 * right — a `bpmn:IntermediateCatchEvent` with the right event definition.
 * None of them can show the one property that makes `await` a *wait*: a real
 * engine actually parks the token there until the message arrives, rather
 * than falling straight through. This suite proves exactly that, driven over
 * Operaton's REST API:
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI, so the
 *      deployed artifact travels exactly the path a user's would.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy `awaiting-confirmation.bpmnscript` and start an instance.
 *   4. Prove the instance is genuinely blocked at the catch *before*
 *      correlating: it is still running, and the engine holds an active
 *      message event subscription for `ConfirmationReceived` on that
 *      instance — not merely "hasn't reached the end yet" for some other
 *      reason.
 *   5. Correlate the message over REST and prove the instance then runs to
 *      completion.
 *
 * The always-on health assertions for this example (validator-clean, and
 * the `intermediateCatchEvent`/message-definition shape of the desugared
 * IR) live in `tests/awaiting-confirmation-example.test.ts`, so this file is
 * Docker-gated in full and is skipped when `SKIP_DOCKER_TESTS=true` (as in
 * CI).
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

/** The deployable example carrying the `await message` walkthrough. */
const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/awaiting-confirmation.bpmnscript',
);

/** Generated BPMN XML, written into the git-ignored `out/` directory. */
const XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/awaiting-confirmation.bpmn',
);

/** `processDefinitionKey` of the deployed process. */
const PROCESS_KEY = 'awaiting-confirmation';

/** Message name the process awaits mid-flow (see the DSL source). */
const MESSAGE_NAME = 'ConfirmationReceived';

// ---------------------------------------------------------------------------
// Engine REST helpers
//
// The fixture adapter covers deploy / start / task list / task completion.
// Message correlation, the event-subscription and history queries this suite
// needs are not part of that contract, so they are issued directly against
// `restBaseUrl()`, with the same fail-loudly-on-a-non-2xx handling the
// adapter itself applies.
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

/** Correlate a message to the one running instance named. */
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

interface EventSubscription {
  activityId: string;
  eventType: string;
  eventName: string;
  processInstanceId: string;
}

/**
 * Active event subscriptions the engine currently holds for a process
 * instance — the runtime record of "which trigger is this instance parked
 * on right now". A message intermediate catch shows up here as an active
 * `message` subscription for as long as the token sits at it, and the
 * subscription disappears the moment it is consumed.
 */
async function eventSubscriptions(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<EventSubscription[]> {
  return engineGet<EventSubscription[]>(
    fixture,
    `/engine-rest/event-subscription?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `eventSubscriptions(${processInstanceId})`,
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

// ---------------------------------------------------------------------------
// Docker-gated E2E suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E: await message on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  /**
   * Before all tests:
   *   1. Compile the `.bpmnscript` DSL → BPMN XML via the real CLI binary.
   *   2. Boot the Operaton Spring Boot container via testcontainers.
   *   3. Deploy the compiled BPMN once — every test below starts its own
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
      'awaiting-confirmation-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * The load-bearing test for the whole construct: the token must
   * genuinely pause at the catch, not fall through it.
   *
   * Before correlation: the instance is still running (not 404'd off the
   * runtime resource), and the engine holds exactly one active `message`
   * event subscription for `ConfirmationReceived` on that instance — proof
   * the token is parked at the catch specifically, not just "somewhere
   * before the end" for an unrelated reason. `FinalizeRequest`, the step
   * after the catch, must not have run yet.
   *
   * Only after `POST /message` correlates the message does the
   * subscription disappear, `FinalizeRequest` run, and the instance reach
   * its end event.
   */
  it('blocks at the message catch until the message is correlated, then completes', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});

    // The instance must park at the catch: an active subscription for
    // exactly this message shows up once SubmitRequest has run.
    const subscriptionsBefore = await waitFor(
      () => eventSubscriptions(fixture, processInstanceId),
      (subs) => subs.some((s) => s.eventName === MESSAGE_NAME),
    );
    expect(subscriptionsBefore).toHaveLength(1);
    expect(subscriptionsBefore[0]!.eventType).toBe('message');
    expect(subscriptionsBefore[0]!.eventName).toBe(MESSAGE_NAME);

    // Still running, and the step after the catch has not fired yet.
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

    // The subscription is consumed, the instance runs on and completes.
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
