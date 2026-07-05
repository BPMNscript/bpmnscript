/**
 * End-to-end integration test — Invoice Approval.
 *
 * Exercises the complete pipeline end-to-end:
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy and start process instances.
 *   4. Drive each instance past the initial `Review Invoice` user task and
 *      assert the post-gateway state (which branch the engine took).
 *
 * The three test cases cover:
 *   - Happy path (senior approval): amount = 5000 → after completing
 *     `Review Invoice`, the gateway condition `${amount > 1000}` evaluates to
 *     true and the next active user task is `Senior Approval`.
 *   - Happy path (auto-approve): amount = 100 → after completing
 *     `Review Invoice`, the gateway condition is false, the default branch
 *     routes to the `AutoApprove` service task (a synchronous JavaDelegate),
 *     the process ends, and no user tasks remain.
 *   - Negative: a BPMN file with `operaton:expression` on a service task is
 *     rejected by `bpmns parse` (non-zero exit code).
 *
 * The Docker-backed describe block is skipped entirely when
 * `SKIP_DOCKER_TESTS=true` (as in CI).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

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

/**
 * Absolute path to the canonical `.bpmnscript` DSL source.
 * Resolves from `tests/e2e/` two levels up to the repo root, then into
 * `examples/spring-boot/processes/`.
 */
const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/invoice-approval.bpmnscript',
);

/**
 * Absolute path for the generated BPMN XML output.
 * Written into `<repo-root>/out/` which the CLI creates via `mkdir -p`.
 * The directory is ignored by `.gitignore`.
 */
const XML_OUT_PATH = path.resolve(__dirname, '../../out/invoice.bpmn');

// ---------------------------------------------------------------------------
// Helper: poll for the next non-empty active-task list (or empty list when
// the caller expects the process to end). Required because Operaton's REST
// API is eventually consistent — a completed task may briefly leave the
// successor task in a pre-active state.
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
// E2E test suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E: invoice-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  /**
   * Before all tests:
   *   1. Ensure the `out/` directory exists (the CLI also creates it, but
   *      doing it here avoids a race if the directory doesn't exist and
   *      the CLI is invoked for the first time).
   *   2. Compile the `.bpmnscript` DSL → BPMN XML via the real CLI binary.
   *   3. Boot the Operaton Spring Boot container via testcontainers.
   *   4. Deploy the compiled BPMN once — every test case reuses the same
   *      process definition.
   *
   * The 300 s timeout accommodates a cold Docker build + Spring Boot startup.
   * Subsequent runs are faster thanks to Docker's layer cache.
   */
  beforeAll(async () => {
    // Ensure the output directory exists so the CLI can write into it.
    mkdirSync(path.dirname(XML_OUT_PATH), { recursive: true });

    execFileSync('npx', ['bpmns', 'build', DSL_PATH, '-o', XML_OUT_PATH], {
      stdio: 'inherit',
    });

    fixture = await startFixture('spring-boot');

    const { deploymentId } = await fixture.deploy(
      XML_OUT_PATH,
      'invoice-approval-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * When `amount = 5000` the gateway condition `${amount > 1000}` is true.
   * The full execution sequence is:
   *
   *   ReviewStart → ReviewInvoice → AmountCheck → SeniorApproval
   *
   * The test:
   *   1. starts the instance,
   *   2. completes the initial `ReviewInvoice` user task,
   *   3. asserts the next active task is `Senior Approval` (the
   *      gateway-routed branch — not `ReviewInvoice` itself).
   *
   * This directly exercises the gateway: a different amount would route to
   * the AutoApprove branch and the assertion would fail.
   */
  it('happy path: senior approval branch', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'invoice-approval',
      { amount: 5000 },
    );

    // The first active user task must be ReviewInvoice — verify, then
    // complete it to traverse to the gateway.
    const initial = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length > 0,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.taskDefinitionKey).toBe('ReviewInvoice');
    await fixture.completeTask(initial[0]!.id);

    // After completion the gateway must route to the SeniorApproval
    // user task (because amount > 1000).
    const next = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) =>
        tasks.length > 0 && tasks[0]!.taskDefinitionKey === 'SeniorApproval',
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.taskDefinitionKey).toBe('SeniorApproval');
    expect(next[0]!.name).toBe('Senior Approval');
  }, 30_000);

  /**
   * When `amount = 100` the gateway condition `${amount > 1000}` is false.
   * The default branch (AutoApprovePath) routes to the AutoApprove service
   * task (JavaDelegate), which executes synchronously. The full sequence is:
   *
   *   ReviewStart → ReviewInvoice → AmountCheck → AutoApprove → Done
   *
   * The test:
   *   1. starts the instance,
   *   2. completes the initial `ReviewInvoice` user task,
   *   3. polls for an empty active-task list, which can only be reached
   *      when the gateway took the default branch and the service task
   *      ran to completion.
   */
  it('happy path: auto-approve branch (service task)', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'invoice-approval',
      { amount: 100 },
    );

    // Same first step: complete ReviewInvoice to reach the gateway.
    const initial = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length > 0,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.taskDefinitionKey).toBe('ReviewInvoice');
    await fixture.completeTask(initial[0]!.id);

    // After completion the gateway must route to the AutoApprove
    // service task (default branch). The JavaDelegate runs
    // synchronously and the process ends, so no user tasks remain.
    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);

  /**
   * `tests/golden/bad-service-task-expression.bpmn` contains a service task
   * with `operaton:expression` instead of `operaton:class`.  The `xmlToIr`
   * transform (used by `bpmns parse`) must reject this with an
   * `UnsupportedServiceTaskFormError`, causing the CLI to exit non-zero.
   *
   * `execFileSync` throws when the subprocess exits with a non-zero status,
   * so wrapping it in `expect(() => ...).toThrow()` is the correct assertion.
   */
  it('refuses unsupported service-task form', () => {
    const badBpmnPath = path.resolve(
      __dirname,
      '../golden/bad-service-task-expression.bpmn',
    );

    // `bpmns parse` must exit non-zero for the unsupported BPMN file.
    expect(() =>
      execFileSync('npx', ['bpmns', 'parse', badBpmnPath], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
