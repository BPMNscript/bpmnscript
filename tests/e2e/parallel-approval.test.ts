// What separates an AND gateway from an XOR one is runtime behavior no compiled
// document shows: the fork makes both branches active at once and the join holds
// the token until both complete. The always-on guard below checks the fork/join
// pair in the IR when Docker is skipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  irOfExample,
  SKIP_DOCKER as SKIP,
  ENGINE_BOOT_TIMEOUT_MS,
} from '../helpers/e2e-fixture.js';
import { waitForTasks } from '../helpers/engine-rest.js';

describe('Always-on guard: parallel-approval.bpmnscript desugars to parallelGateway fork/join', () => {
  it('astToIr emits exactly two parallelGateway elements (fork + join)', async () => {
    const ir = await irOfExample('parallel-approval');
    const parallelGateways = ir.flowElements.filter(
      (fe) => fe.kind === 'parallelGateway',
    );

    expect(parallelGateways).toHaveLength(2);
  });

  it('the IR contains both parallel branch user tasks (ApproveA and ApproveB)', async () => {
    const ir = await irOfExample('parallel-approval');
    const userTaskIds = ir.flowElements
      .filter((fe) => fe.kind === 'userTask')
      .map((fe) => fe.id);

    expect(userTaskIds).toContain('ApproveA');
    expect(userTaskIds).toContain('ApproveB');
  });
});

describe.skipIf(SKIP)('E2E: parallel-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  // One deployment serves every case.
  beforeAll(async () => {
    fixture = await deployExamples('parallel-approval');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  // A parallel gateway fires every outgoing branch unconditionally, where an
  // exclusive gateway fires exactly one.
  it('AND-split: both parallel user tasks are active simultaneously after the fork', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'parallel-approval',
      {},
    );

    const tasks = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 2,
    );

    expect(tasks).toHaveLength(2);

    const keys = tasks.map((t) => t.taskDefinitionKey).sort();
    expect(keys).toEqual(['ApproveA', 'ApproveB']);
  }, 30_000);

  // An XOR join would let the process continue after the first completion.
  it('AND-join: process ends only after BOTH tasks complete, not after the first', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'parallel-approval',
      {},
    );

    const bothActive = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 2,
    );
    expect(bothActive).toHaveLength(2);

    const taskA = bothActive.find((t) => t.taskDefinitionKey === 'ApproveA');
    const taskB = bothActive.find((t) => t.taskDefinitionKey === 'ApproveB');
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();

    await fixture.completeTask(taskA!.id);

    // The join has not fired: ApproveB is still active. The engine processes
    // the completion synchronously, so the poll is only there to avoid a race.
    const afterFirst = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length <= 1,
    );
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.taskDefinitionKey).toBe('ApproveB');

    await fixture.completeTask(afterFirst[0]!.id);

    const afterBoth = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 0,
    );
    expect(afterBoth).toHaveLength(0);
  }, 30_000);
});
