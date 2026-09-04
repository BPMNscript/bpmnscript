// Both paths run for real: the one a delegate approves with no human step, and
// the one a submitted form field decides. The always-on guard below holds the
// structural facts when Docker is skipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  irOfExample,
  SKIP_DOCKER as SKIP,
  ENGINE_BOOT_TIMEOUT_MS,
} from '../helpers/e2e-fixture.js';
import { waitForTasks } from '../helpers/engine-rest.js';

// Read off the compiled IR, so it holds without an engine.
describe('Always-on guard: loan-approval.bpmnscript migration', () => {
  it('no longer contains the InitDelegate default-seeding service task', async () => {
    const ir = await irOfExample('loan-approval');
    const initDelegateTasks = ir.flowElements.filter(
      (fe) =>
        fe.kind === 'serviceTask' &&
        fe.binding.kind === 'class' &&
        fe.binding.className === 'com.example.loan.InitDelegate',
    );
    expect(initDelegateTasks).toHaveLength(0);
  });

  it('declares its start variables and the approval decision as form fields', async () => {
    const ir = await irOfExample('loan-approval');

    const start = ir.flowElements.find((fe) => fe.kind === 'startEvent');
    expect(
      start?.kind === 'startEvent' && start.formFields?.map((f) => f.id),
    ).toEqual(['amount', 'creditScore']);

    const approve = ir.flowElements.find(
      (fe) => fe.kind === 'userTask' && fe.id === 'Approve',
    );
    expect(
      approve?.kind === 'userTask' && approve.formFields?.map((f) => f.id),
    ).toEqual(['approved']);
  });
});

describe.skipIf(SKIP)('E2E: loan-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples('loan-approval');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  });

  // amount = 5000, creditScore = 800 runs RequestReceived -> AssessRisk
  // (risk="low") -> AutoApprove (approved=true) -> NotifyAccepted -> Done with
  // no user task ever becoming active. AutoApproveDelegate is what sets
  // `approved`, so the final `${approved == true}` gateway resolves.
  it('fully automated: low-risk small loan auto-approves to completion', async () => {
    const { processInstanceId } = await fixture.startProcess('loan-approval', {
      amount: 5000,
      creditScore: 800,
    });

    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);

  // amount = 50000 skips auto-approval and routes to the `Approve` user task.
  // Completing it with the form field `approved = true` drives the final
  // gateway to the accept branch.
  it('manual decision: large loan routes to the Approve task, which resolves the gateway', async () => {
    const { processInstanceId } = await fixture.startProcess('loan-approval', {
      amount: 50000,
      creditScore: 800,
    });

    const pending = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length > 0,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.taskDefinitionKey).toBe('Approve');

    // Submit the `approved` form field, exactly as Tasklist would.
    await fixture.completeTask(pending[0]!.id, { approved: true });

    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);
});
