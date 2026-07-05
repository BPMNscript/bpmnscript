/**
 * End-to-end integration test — Parallel Approval.
 *
 * Exercises the complete pipeline end-to-end for a process that uses a
 * parallel (AND) gateway:
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy and start a process instance.
 *   4. Assert AND-split semantics: both parallel user tasks are active
 *      simultaneously right after the fork.
 *   5. Assert AND-join semantics: the process does NOT end after completing
 *      only the first task; it ends only after completing both.
 *
 * An always-on (non-Docker) guard in a separate `describe` block verifies
 * that `parallel-approval.bpmnscript` desugars to a parallelGateway fork/join
 * pair in the IR, so a broken example is caught even when Docker is skipped.
 *
 * The Docker-backed describe block is skipped when `SKIP_DOCKER_TESTS=true`
 * (as in CI).
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
 * Absolute path to the parallel-approval `.bpmnscript` DSL source.
 * Resolves from `tests/e2e/` two levels up to the repo root, then into
 * `examples/spring-boot/processes/`.
 */
const DSL_PATH = path.resolve(
  __dirname,
  '../../examples/spring-boot/processes/parallel-approval.bpmnscript',
);

/**
 * Absolute path for the generated BPMN XML output.
 * Written into `<repo-root>/out/` which is ignored by `.gitignore`.
 */
const XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/parallel-approval.bpmn',
);

// ---------------------------------------------------------------------------
// Helper: poll for the next active-task list that satisfies a predicate.
// Required because Operaton's REST API is eventually consistent — a completed
// task may briefly leave successor tasks in a pre-active state.
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
// This describe block runs unconditionally (no skipIf). It parses the
// parallel-approval.bpmnscript source and checks that astToIr produces a
// parallelGateway fork/join pair. A broken example is caught here even when
// the engine test is skipped.
// ---------------------------------------------------------------------------

describe('Always-on guard: parallel-approval.bpmnscript desugars to parallelGateway fork/join', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it('astToIr emits exactly two parallelGateway elements (fork + join)', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const document = await parse(source);

    // Fail fast if the source has parser errors.
    const parserErrors = document.parseResult.parserErrors;
    expect(
      parserErrors,
      'Parser errors in parallel-approval.bpmnscript',
    ).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);
    const parallelGateways = ir.flowElements.filter(
      (fe) => fe.kind === 'parallelGateway',
    );

    // The `parallel { { } { } }` construct must desugar to exactly one fork and
    // one join — both are parallel gateways in the IR.
    expect(parallelGateways).toHaveLength(2);
  });

  it('the IR contains both parallel branch user tasks (ApproveA and ApproveB)', async () => {
    const source = readFileSync(DSL_PATH, 'utf-8');
    const document = await parse(source);
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);
    const userTaskIds = ir.flowElements
      .filter((fe) => fe.kind === 'userTask')
      .map((fe) => fe.id);

    expect(userTaskIds).toContain('ApproveA');
    expect(userTaskIds).toContain('ApproveB');
  });
});

// ---------------------------------------------------------------------------
// Docker-gated E2E suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E: parallel-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  /**
   * Before all tests:
   *   1. Ensure the `out/` directory exists.
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
      'parallel-approval-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * After starting the process, both user tasks (`ApproveA` and `ApproveB`)
   * must be active at the same time (AND-split semantics).
   *
   * This is the distinguishing assertion between AND-split and XOR-split: a
   * parallel gateway fires all outgoing branches unconditionally, whereas an
   * exclusive gateway fires exactly one.
   */
  it('AND-split: both parallel user tasks are active simultaneously after the fork', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'parallel-approval',
      {},
    );

    // Both branches must be active simultaneously — wait for exactly two tasks.
    const tasks = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 2,
    );

    expect(tasks).toHaveLength(2);

    const keys = tasks.map((t) => t.taskDefinitionKey).sort();
    expect(keys).toEqual(['ApproveA', 'ApproveB']);
  }, 30_000);

  /**
   * After starting the process and confirming both tasks are active:
   *   1. Complete `ApproveA` — assert the process is NOT yet finished
   *      (ApproveB is still active, so the AND-join has not fired).
   *   2. Complete `ApproveB` — assert the process IS finished (the AND-join
   *      fires, driving the process to `ParallelEnd`).
   *
   * This is the distinguishing assertion for AND-join semantics: an XOR join
   * would let the process continue after the first completion.
   */
  it('AND-join: process ends only after BOTH tasks complete, not after the first', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'parallel-approval',
      {},
    );

    // Wait for both tasks to be active.
    const bothActive = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 2,
    );
    expect(bothActive).toHaveLength(2);

    // Find the two tasks by their definition key.
    const taskA = bothActive.find((t) => t.taskDefinitionKey === 'ApproveA');
    const taskB = bothActive.find((t) => t.taskDefinitionKey === 'ApproveB');
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();

    // Complete the first task (ApproveA).
    await fixture.completeTask(taskA!.id);

    // AND-join has NOT fired yet — ApproveB is still active.
    // Poll briefly and assert we still have exactly one task (ApproveB).
    const afterFirst = await waitForTasks(
      fixture,
      processInstanceId,
      // Wait until the task count stabilizes at ≤1 (the engine processes the
      // completion synchronously, so this is fast, but eventual-consistency
      // polling avoids a race).
      (t) => t.length <= 1,
    );
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.taskDefinitionKey).toBe('ApproveB');

    // Complete the second task (ApproveB) — now the AND-join fires.
    await fixture.completeTask(afterFirst[0]!.id);

    // Process must have ended — no active tasks remain.
    const afterBoth = await waitForTasks(
      fixture,
      processInstanceId,
      (t) => t.length === 0,
    );
    expect(afterBoth).toHaveLength(0);
  }, 30_000);
});
