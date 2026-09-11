// The engine evaluates `${amount > 1000}` against the instance's own variables,
// so only a real instance shows which branch an exclusive gateway takes. Both
// amounts run here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import { waitForTasks } from '../helpers/engine-rest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Addressed by path rather than run through `npx`, which resolves a command
// by walking `node_modules/.bin` upwards and so can reach a neighbouring
// checkout's build instead of this one's (see `tests/fixtures/index.ts`).
const CLI_ENTRY = path.resolve(__dirname, '../../packages/cli/bin/cli.js');

describe.skipIf(SKIP)('E2E: invoice-approval on Spring Boot Operaton', () => {
  let fixture: FixtureAdapter;

  // One deployment serves every case.
  beforeAll(async () => {
    fixture = await deployExamples('invoice-approval');
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  }, ENGINE_STOP_TIMEOUT_MS);

  // ReviewStart -> ReviewInvoice -> AmountCheck -> SeniorApproval.
  it('happy path: senior approval branch', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'invoice-approval',
      { amount: 5000 },
    );

    const initial = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length > 0,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.taskDefinitionKey).toBe('ReviewInvoice');
    await fixture.completeTask(initial[0]!.id);

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

  // ReviewStart -> ReviewInvoice -> AmountCheck -> AutoApprove -> Done. An
  // empty task list is only reachable once the default branch ran the delegate
  // through to the end.
  it('happy path: auto-approve branch (service task)', async () => {
    const { processInstanceId } = await fixture.startProcess(
      'invoice-approval',
      { amount: 100 },
    );

    const initial = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length > 0,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.taskDefinitionKey).toBe('ReviewInvoice');
    await fixture.completeTask(initial[0]!.id);

    const remaining = await waitForTasks(
      fixture,
      processInstanceId,
      (tasks) => tasks.length === 0,
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);

  // The fixture's service task carries no execution binding, so `xmlToIr`
  // rejects it with `UnsupportedServiceTaskFormError` and the CLI exits 1.
  // Checking exit status and stderr content, rather than just that
  // `execFileSync` threw, is what tells a real refusal apart from the CLI
  // never having run at all (wrong path, spawn failure, timeout).
  it('refuses unsupported service-task form', () => {
    const badBpmnPath = path.resolve(
      __dirname,
      '../golden/bad-service-task-no-binding.bpmn',
    );

    let status: number | null = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [CLI_ENTRY, 'parse', badBpmnPath], {
        stdio: 'pipe',
      });
      expect.fail('bpmns parse should have exited non-zero');
    } catch (err) {
      const e = err as { status: number | null; stderr: Buffer };
      status = e.status;
      stderr = e.stderr.toString();
    }

    expect(status).toBe(1);
    expect(stderr).toContain("Service task 'BadService_1'");
    expect(stderr).toContain('unsupported service task form');
  }, 30_000);
});
