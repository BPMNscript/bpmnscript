// Three ways of entering a process that no compiled document shows: a message
// correlated with no instance to aim at, a signal broadcast to whatever
// subscribed at deployment, and a timer job parked until something fires it.
// The terminate end is here for the same reason: what separates it from a
// plain end is that it stops a sibling branch still parked on its own task.
// The audit timer is dated 2099, so only the test can fire it.
// A fourth way, entering the same process by two different starts, checks that
// each start is a real entry and not a pass-through the other flows into.
// A link pair is a fifth: the token leaves a throw with no drawn flow and
// appears at the catch of the same name, which no compiled document draws.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { irToXml } from '@bpmn-script/transform';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  dslPath,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  activityIdsIncluding,
  broadcastSignal,
  executeJob,
  historicActivities,
  historicInstances,
  jobsOf,
  startByMessage,
  waitFor,
  waitForTaskId,
  waitForTaskKeys,
  waitUntilFinished,
} from '../helpers/engine-rest.js';
import { roundTrip, validate } from '../helpers/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(SKIP)('E2E: start, end, throw and link on Operaton', () => {
  let fixture: FixtureAdapter;

  // A broadcast names no instance in its response, so the one it created is
  // found by diffing the definition's instance list around the call.
  async function signalStockAlert(): Promise<string> {
    const before = new Set(
      (await historicInstances(fixture, 'stock-alert')).map((i) => i.id),
    );
    await broadcastSignal(fixture, 'StockRunningLow');
    const after = await waitFor(
      () => historicInstances(fixture, 'stock-alert'),
      (list) => list.some((i) => !before.has(i.id)),
    );
    const created = after.find((i) => !before.has(i.id));
    expect(
      created,
      'no stock-alert instance appeared after the broadcast',
    ).toBeDefined();
    return created!.id;
  }

  beforeAll(async () => {
    fixture = await deployExamples(
      'order-intake',
      'stock-alert',
      'scheduled-audit',
      'support-ticket',
      'order-rework',
    );
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  }, ENGINE_STOP_TIMEOUT_MS);

  it('message start: a correlated message with no instance to aim at starts one', async () => {
    const processInstanceId = await startByMessage(fixture, 'OrderReceived');
    expect(processInstanceId).toBeTruthy();

    expect(
      await waitForTaskKeys(fixture, processInstanceId, (k) =>
        k.includes('ConfirmOrder'),
      ),
    ).toContain('ConfirmOrder');
  }, 60_000);

  // Neither thrown message carries an implementation, so the question the
  // engine answers here is whether it passes the token through both or refuses
  // the definition outright.
  it('message throw and message end: the token passes through both and the instance ends', async () => {
    const processInstanceId = await startByMessage(fixture, 'OrderReceived');
    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ConfirmOrder'),
    );

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderAcknowledged',
    );
    expect(activityIds).toContain('NotifyWarehouse');

    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
  }, 60_000);

  it('signal start: a broadcast starts an instance with both parallel tasks active', async () => {
    const processInstanceId = await signalStockAlert();

    expect(
      await waitForTaskKeys(fixture, processInstanceId, (k) => k.length === 2),
    ).toEqual(['EscalateToBuyer', 'ReorderStock']);
  }, 60_000);

  // A plain end would leave ReorderStock waiting and the instance running.
  it('terminate end: reaching it cancels the sibling branch still parked on a task', async () => {
    const processInstanceId = await signalStockAlert();
    await waitForTaskKeys(fixture, processInstanceId, (k) => k.length === 2);

    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'EscalateToBuyer'),
    );

    const activityIds = await activityIdsIncluding(
      fixture,
      processInstanceId,
      'OrderAbandoned',
    );
    expect(activityIds).not.toContain('Restocked');

    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
    expect(await fixture.getActiveTasks(processInstanceId)).toEqual([]);

    const reorder = (await historicActivities(fixture, processInstanceId)).find(
      (a) => a.activityId === 'ReorderStock',
    );
    expect(reorder?.canceled).toBe(true);
  }, 60_000);

  it('timer start: the parked job creates the instance only once it is fired', async () => {
    const jobs = await waitFor(
      () => jobsOf(fixture, 'scheduled-audit'),
      (list) => list.length > 0,
    );
    expect(jobs).toHaveLength(1);
    expect(await historicInstances(fixture, 'scheduled-audit')).toEqual([]);

    await executeJob(fixture, jobs[0]!.id);

    const instances = await waitFor(
      () => historicInstances(fixture, 'scheduled-audit'),
      (list) => list.length > 0,
    );
    expect(instances).toHaveLength(1);
    expect(
      await waitForTaskKeys(fixture, instances[0]!.id, (k) =>
        k.includes('ReviewAudit'),
      ),
    ).toContain('ReviewAudit');
  }, 60_000);

  it('two starts: an instance opened by key enters through the plain start, one opened by message through the message start, and both reach the same step', async () => {
    const { processInstanceId: byKey } =
      await fixture.startProcess('support-ticket');
    const byEmail = await startByMessage(fixture, 'TicketEmailed');

    for (const [processInstanceId, entry] of [
      [byKey, 'ByAgent'],
      [byEmail, 'ByEmail'],
    ] as const) {
      expect(
        await waitForTaskKeys(fixture, processInstanceId, (k) =>
          k.includes('Triage'),
        ),
      ).toEqual(['Triage']);

      expect(
        (
          await activityIdsIncluding(fixture, processInstanceId, 'Triage')
        ).sort(),
      ).toEqual([entry, 'Triage'].sort());
    }
  }, 60_000);

  it("link pair: the token leaves the throw with no drawn flow and appears at the catch's successor, on the compiled document and again on its round trip", async () => {
    // Neither link end reaches history: the catch writes no row
    // (`HistoryParseListener.parseIntermediateCatchEvent` skips it) and the
    // throw has no activity to write one.
    async function reworkJourney(): Promise<void> {
      const { processInstanceId } = await fixture.startProcess(
        'order-rework',
        {},
      );

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Review'),
        { approved: false },
      );
      expect(
        await waitForTaskKeys(fixture, processInstanceId, (k) =>
          k.includes('Rework'),
        ),
      ).toEqual(['Rework']);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Rework'),
      );
      expect(
        await waitForTaskKeys(fixture, processInstanceId, (k) =>
          k.includes('Review'),
        ),
      ).toEqual(['Review']);

      await fixture.completeTask(
        await waitForTaskId(fixture, processInstanceId, 'Review'),
        { approved: true },
      );
      expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);

      const activityIds = (await historicActivities(fixture, processInstanceId))
        .map((a) => a.activityId)
        .filter((id) => !id.startsWith('Gateway_'))
        .sort();
      expect(activityIds).toEqual([
        'Done',
        'Received',
        'Review',
        'Review',
        'Rework',
      ]);
    }

    await reworkJourney();

    const run = await roundTrip(readFileSync(dslPath('order-rework'), 'utf-8'));
    expect((await validate(run.dsl)).diagnostics).toEqual([]);

    const roundTripXmlPath = resolve(
      __dirname,
      '../../out/order-rework.round-trip.bpmn',
    );
    mkdirSync(dirname(roundTripXmlPath), { recursive: true });
    writeFileSync(roundTripXmlPath, await irToXml(run.ir3));

    const { deploymentId } = await fixture.deploy(
      roundTripXmlPath,
      'order-rework-round-trip-test',
    );
    expect(deploymentId).toBeTruthy();

    await reworkJourney();
  }, 60_000);
});
