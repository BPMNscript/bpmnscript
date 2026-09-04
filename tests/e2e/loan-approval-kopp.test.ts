// Which branch opens the `AssessRisk` task and whether the final gateway
// short-circuits are engine decisions, so both halves run for real. The
// always-on guard below holds the structural facts when Docker is skipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  irOfExample,
  SKIP_DOCKER as SKIP,
  ENGINE_BOOT_TIMEOUT_MS,
} from '../helpers/e2e-fixture.js';
import { waitForTasks } from '../helpers/engine-rest.js';

describe('Always-on guard: loan-approval-kopp.bpmnscript migration', () => {
  it('declares its start variables and the assessor result as form fields', async () => {
    const ir = await irOfExample('loan-approval-kopp');

    const start = ir.flowElements.find((fe) => fe.kind === 'startEvent');
    expect(
      start?.kind === 'startEvent' && start.formFields?.map((f) => f.id),
    ).toEqual(['amount', 'creditScore']);

    const assess = ir.flowElements.find(
      (fe) => fe.kind === 'userTask' && fe.id === 'AssessRisk',
    );
    expect(
      assess?.kind === 'userTask' && assess.formFields?.map((f) => f.id),
    ).toEqual(['assessorRes']);
  });

  it('retains the InitDelegate seed that guards the assessment skip-path', async () => {
    const ir = await irOfExample('loan-approval-kopp');
    const initDelegateTasks = ir.flowElements.filter(
      (fe) =>
        fe.kind === 'serviceTask' &&
        fe.binding.kind === 'class' &&
        fe.binding.className === 'com.example.loan.kopp.InitDelegate',
    );
    expect(initDelegateTasks).toHaveLength(1);
  });
});

describe.skipIf(SKIP)('E2E: loan-approval-kopp on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples('loan-approval-kopp');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  // creditScore = 750 gives intRes = "low", which opens the conditional
  // `AssessRisk` task inside the parallel branch while the external branches
  // wait at the join. Completing it with assessorRes = "low" satisfies the final
  // accept gateway `intRes == "low" && assessorRes == "low"`.
  it('manual assessment: strong internal rating opens AssessRisk, which resolves the gateway', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'loan-approval-kopp',
      { amount: 80000, creditScore: 750 },
    );

    const pending = await waitForTasks(fixture, processInstanceId, (tasks) =>
      tasks.some((t) => t.taskDefinitionKey === 'AssessRisk'),
    );
    const assess = pending.find((t) => t.taskDefinitionKey === 'AssessRisk');
    expect(assess).toBeDefined();

    // Submit the `assessorRes` form field, exactly as Tasklist would.
    await fixture.completeTask(assess!.id, { assessorRes: 'low' });

    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);

  // creditScore = 550 gives intRes = "high", which skips `AssessRisk` entirely.
  // The final gateway short-circuits at `intRes == "low"` without reading
  // assessorRes and routes to the reject branch.
  it('automated skip-path: weak rating skips assessment and rejects to completion', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'loan-approval-kopp',
      { amount: 5000, creditScore: 550 },
    );

    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);
});
