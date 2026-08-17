/**
 * The `await message` intermediate catch on a running engine.
 *
 * Static checking can only show that the compiled BPMN looks right, a
 * `bpmn:IntermediateCatchEvent` with the right event definition. It cannot show
 * the property that makes `await` a wait: a real engine parks the token there
 * until the message arrives rather than falling straight through. This suite
 * builds the example with the real `bpmns` CLI, boots Operaton via
 * testcontainers, and proves over REST that the instance is blocked at the catch
 * (still running, with an active message event subscription) before correlating
 * the message and watching it run to completion.
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
  correlateMessage,
  eventSubscriptions,
  historicActivities,
  isRunning,
  waitFor,
} from '../helpers/engine-rest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true';

const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/awaiting-confirmation.bpmnscript',
);

const XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/awaiting-confirmation.bpmn',
);

const PROCESS_KEY = 'awaiting-confirmation';

const MESSAGE_NAME = 'ConfirmationReceived';

describe.skipIf(SKIP)('E2E: await message on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  // The 300 s timeout accommodates a cold image build plus Spring Boot startup.
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
