import { describe, it, expect, beforeAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  DEPLOY_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import { waitForTaskId, waitForTaskKeys } from '../helpers/engine-rest.js';

const PROCESS_KEY = 'claim-routing';

const SPLIT = 'Gateway_claim-routing_1_split';
const FORK = 'Gateway_claim-routing_2_fork';

// `BpmnBehaviorLogger.stuckExecutionException`, thrown by both gateway kinds
// when no outgoing flow is taken and none is the default.
const stuck = (gatewayId: string): RegExp =>
  new RegExp(
    `ENGINE-02004 No outgoing sequence flow for the element with id '${gatewayId}' could be selected for continuing the process`,
  );

describe.skipIf(SKIP)("E2E: 'else fail' on Spring Boot Operaton", () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(PROCESS_KEY);
  }, DEPLOY_TIMEOUT_MS);

  // The raw call, since the adapter throws before the status can be read.
  async function post(
    path: string,
    variables: Record<string, { value: unknown }>,
  ): Promise<{ status: number; body: string }> {
    const response = await fetch(
      `${fixture.restBaseUrl()}/engine-rest${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables }),
      },
    );
    return { status: response.status, body: await response.text() };
  }

  it('runs the route whose condition holds, and the fork the branch whose condition holds', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
      amount: 200,
      injury: true,
    });
    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'QuickReview'),
    );

    expect(
      await waitForTaskKeys(
        fixture,
        processInstanceId,
        (keys) => keys.length > 0 && !keys.includes('QuickReview'),
      ),
    ).toEqual(['MedicalCheck']);
  }, 60_000);

  it('stops the start with the engine error when no condition of the exclusive split holds', async () => {
    const started = await post(`/process-definition/key/${PROCESS_KEY}/start`, {
      amount: { value: 99999 },
      injury: { value: false },
    });

    expect({
      status: started.status,
      stuck: stuck(SPLIT).test(started.body),
    }).toEqual({ status: 500, stuck: true });
  }, 60_000);

  it('refuses to complete the task before the inclusive fork when no branch condition holds, and leaves the task open', async () => {
    const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {
      amount: 200,
      injury: false,
    });
    const taskId = await waitForTaskId(
      fixture,
      processInstanceId,
      'QuickReview',
    );

    const completed = await post(`/task/${taskId}/complete`, {});

    expect({
      status: completed.status,
      stuck: stuck(FORK).test(completed.body),
      open: (await fixture.getActiveTasks(processInstanceId)).map(
        (task) => task.taskDefinitionKey,
      ),
    }).toEqual({ status: 500, stuck: true, open: ['QuickReview'] });
  }, 60_000);
});
