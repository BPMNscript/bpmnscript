/**
 * End-to-end integration test — Loan Approval.
 *
 * Exercises the full pipeline for a process that mixes service tasks (Java
 * delegates), a user task with a form, and nested exclusive gateways:
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI.
 *   2. Boot Operaton via testcontainers (Spring Boot image, delegates on the
 *      classpath).
 *   3. Deploy and start process instances.
 *   4. Drive each instance to completion and assert the branch it took.
 *
 * The two Docker-backed cases cover the paths that no longer rely on the
 * removed `InitDelegate` default-seeding:
 *   - Fully automated: a low-risk small loan is auto-approved end-to-end with
 *     no user interaction. `approved` is set by `AutoApproveDelegate`, so the
 *     final `${approved == true}` gateway resolves without the old seed.
 *   - Manual decision: a large loan routes to the `Approve` user task, whose
 *     `approved` form field is submitted on completion and drives the gateway.
 *
 * An always-on (non-Docker) guard asserts the structural facts of the migration
 * — the `InitDelegate` service task is gone and the start/user forms are present
 * — so a regression is caught even when the engine test is skipped.
 *
 * The Docker-backed describe block is skipped when `SKIP_DOCKER_TESTS=true`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';
import { astToIr } from '@bpmn-script/transform';

import { startFixture } from '../fixtures/index.js';
import type { FixtureAdapter } from '../fixtures/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true';

const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/loan-approval.bpmnscript',
);
const XML_OUT_PATH = path.resolve(__dirname, '../../out/loan-approval.bpmn');

// ---------------------------------------------------------------------------
// Helper: poll for the next active-task list that satisfies a predicate.
// Operaton's REST API is eventually consistent — a completed task may briefly
// leave successor tasks in a pre-active state.
// ---------------------------------------------------------------------------

async function waitForTasks(
  fixture: FixtureAdapter,
  processInstanceId: string,
  predicate: (
    tasks: Array<{
      id: string;
      name: string;
      taskDefinitionKey: string;
      assignee?: string;
    }>,
  ) => boolean,
  timeoutMs = 10_000,
): Promise<
  Array<{
    id: string;
    name: string;
    taskDefinitionKey: string;
    assignee?: string;
  }>
> {
  const start = Date.now();
  let tasks = await fixture.getActiveTasks(processInstanceId);
  while (!predicate(tasks) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    tasks = await fixture.getActiveTasks(processInstanceId);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Always-on guard: no Docker required
//
// Verifies the migration facts directly on the compiled IR: the InitDelegate
// service task was removed, and the start event and `Approve` user task carry
// the form fields that now declare their variables.
// ---------------------------------------------------------------------------

describe('Always-on guard: loan-approval.bpmnscript migration', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it('no longer contains the InitDelegate default-seeding service task', async () => {
    const document = await parse(readFileSync(DSL_PATH, 'utf-8'));
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);
    const initDelegateTasks = ir.flowElements.filter(
      (fe) =>
        fe.kind === 'serviceTask' &&
        fe.javaClass === 'com.example.loan.InitDelegate',
    );
    expect(initDelegateTasks).toHaveLength(0);
  });

  it('declares its start variables and the approval decision as form fields', async () => {
    const document = await parse(readFileSync(DSL_PATH, 'utf-8'));
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);

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

// ---------------------------------------------------------------------------
// Docker-gated E2E suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E: loan-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    mkdirSync(path.dirname(XML_OUT_PATH), { recursive: true });

    execFileSync('npx', ['bpmns', 'build', DSL_PATH, '-o', XML_OUT_PATH], {
      stdio: 'inherit',
    });

    fixture = await startFixture('spring-boot');

    const { deploymentId } = await fixture.deploy(
      XML_OUT_PATH,
      'loan-approval-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * A low-risk small loan (`amount = 5000`, `creditScore = 800`) is handled
   * without any human step:
   *
   *   RequestReceived → AssessRisk (risk="low") → AutoApprove (approved=true)
   *     → NotifyAccepted → Done
   *
   * No user task ever becomes active. This is the direct check that removing
   * `InitDelegate` is safe: `approved` is set by `AutoApproveDelegate`, so the
   * final `${approved == true}` gateway resolves and the process ends.
   */
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

  /**
   * A large loan (`amount = 50000`) skips the small-loan auto-approval and
   * routes to the `Approve` user task. Completing it with `approved = true`
   * (the form field's variable) drives the `${approved == true}` gateway to the
   * accept branch and the process ends.
   */
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
