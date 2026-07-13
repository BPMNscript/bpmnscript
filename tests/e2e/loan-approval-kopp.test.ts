/**
 * End-to-end integration test — Loan Approval (Kopp 2009 variant).
 *
 * Exercises a process with a parallel gateway whose branches mix service tasks
 * (external/internal rating delegates) with a conditional user task, and a final
 * exclusive gateway over the collected ratings.
 *
 *   1. Build BPMN XML from the DSL source via the real `bpmns` CLI.
 *   2. Boot Operaton via testcontainers (Spring Boot image).
 *   3. Deploy and start process instances.
 *   4. Drive each instance to completion and assert its outcome.
 *
 * The two Docker-backed cases cover both halves of the parallel branch:
 *   - Manual assessment: a high-value loan with a strong internal rating opens
 *     the `AssessRisk` user task, whose `assessorRes` form field is submitted on
 *     completion and drives the final accept gateway.
 *   - Automated skip-path: a weak internal rating skips `AssessRisk` entirely,
 *     and the process completes to a rejection. This is the branch the retained
 *     `InitDelegate` seed guards (`assessorRes` is only read behind an
 *     `intRes == "low"` short-circuit, so the skip-path never reaches it).
 *
 * An always-on (non-Docker) guard asserts the migration facts: the start/user
 * forms are present and — unlike loan-approval — the `InitDelegate` seed is
 * deliberately retained.
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
  '../../examples/spring-boot/processes/loan-approval-kopp.bpmnscript',
);
const XML_OUT_PATH = path.resolve(
  __dirname,
  '../../out/loan-approval-kopp.bpmn',
);

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
// ---------------------------------------------------------------------------

describe('Always-on guard: loan-approval-kopp.bpmnscript migration', () => {
  let parse: ReturnType<typeof parseHelper<Model>>;

  beforeAll(() => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    parse = parseHelper<Model>(services.BpmnScript);
  });

  it('declares its start variables and the assessor result as form fields', async () => {
    const document = await parse(readFileSync(DSL_PATH, 'utf-8'));
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);

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
    const document = await parse(readFileSync(DSL_PATH, 'utf-8'));
    expect(document.parseResult.parserErrors).toHaveLength(0);

    const ir = astToIr(document.parseResult.value);
    const initDelegateTasks = ir.flowElements.filter(
      (fe) =>
        fe.kind === 'serviceTask' &&
        fe.javaClass === 'com.example.loan.kopp.InitDelegate',
    );
    expect(initDelegateTasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Docker-gated E2E suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E: loan-approval-kopp on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    mkdirSync(path.dirname(XML_OUT_PATH), { recursive: true });

    execFileSync('npx', ['bpmns', 'build', DSL_PATH, '-o', XML_OUT_PATH], {
      stdio: 'inherit',
    });

    fixture = await startFixture('spring-boot');

    const { deploymentId } = await fixture.deploy(
      XML_OUT_PATH,
      'loan-approval-kopp-test',
    );
    expect(deploymentId).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * A strong internal rating (`creditScore = 750` ⇒ `intRes = "low"`) opens the
   * conditional `AssessRisk` user task inside the parallel branch. The other two
   * branches (external S1/S2) finish and wait at the join. Completing
   * `AssessRisk` with `assessorRes = "low"` satisfies the final accept gateway
   * `intRes == "low" && assessorRes == "low"`, and the process ends.
   */
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

  /**
   * A weak internal rating (`creditScore = 550` ⇒ `intRes = "high"`) skips the
   * `AssessRisk` task; no user task ever becomes active. The final gateway
   * short-circuits at `intRes == "low"` without reading `assessorRes`, routes to
   * the reject branch, and the process ends. This confirms the skip-path — the
   * one the retained seed guards — completes.
   */
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
