/**
 * Talking to a running Operaton engine over REST.
 *
 * The fixture adapter covers deploy, start, task list, and task completion.
 * Message correlation and the history and event-subscription queries are not
 * part of that contract, so they are issued directly against `restBaseUrl()`,
 * failing on a non-2xx as the adapter does.
 *
 * This is plumbing only: what a suite concludes from the answers stays in that
 * suite.
 */

import type { FixtureAdapter } from '../fixtures/index.js';

/** Throw with the response body when the engine answered non-2xx. */
export async function assertOk(
  response: Response,
  context: string,
): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Operaton REST error [${context}]: HTTP ${response.status} — ${body}`,
    );
  }
}

/** GET one engine resource as JSON. */
export async function engineGet<T>(
  fixture: FixtureAdapter,
  resource: string,
  context: string,
): Promise<T> {
  const response = await fetch(fixture.restBaseUrl() + resource);
  await assertOk(response, context);
  return (await response.json()) as T;
}

/**
 * Correlate a message to the named instance, delivering it to whichever message
 * event subscription that instance holds.
 */
export async function correlateMessage(
  fixture: FixtureAdapter,
  messageName: string,
  processInstanceId: string,
): Promise<void> {
  const response = await fetch(fixture.restBaseUrl() + '/engine-rest/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageName, processInstanceId }),
  });
  await assertOk(response, `correlateMessage(${messageName})`);
}

export interface HistoricActivityInstance {
  activityId: string;
  endTime: string | null;
  canceled: boolean;
}

/** Every activity the engine recorded for an instance, running or finished. */
export async function historicActivities(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<HistoricActivityInstance[]> {
  return engineGet<HistoricActivityInstance[]>(
    fixture,
    `/engine-rest/history/activity-instance?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `historicActivities(${processInstanceId})`,
  );
}

export interface EventSubscription {
  activityId: string;
  eventType: string;
  eventName: string;
  processInstanceId: string;
}

/**
 * The event subscriptions the engine holds for an instance, its record of which
 * trigger the instance is parked on. A message intermediate catch shows up as an
 * active `message` subscription while the token sits at it, and the subscription
 * disappears once it is consumed.
 */
export async function eventSubscriptions(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<EventSubscription[]> {
  return engineGet<EventSubscription[]>(
    fixture,
    `/engine-rest/event-subscription?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `eventSubscriptions(${processInstanceId})`,
  );
}

/**
 * Whether a process instance is still running.
 *
 * Asked of the single-instance resource rather than the collection query: the
 * runtime collection has no `processInstanceId` filter, so a query built on
 * that name silently reports on every other instance the shared engine still
 * holds. `404` here means the instance is gone from the runtime, which for a
 * process that cannot be cancelled from outside means it ran to its end.
 */
export async function isRunning(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<boolean> {
  const response = await fetch(
    `${fixture.restBaseUrl()}/engine-rest/process-instance/${encodeURIComponent(processInstanceId)}`,
  );
  if (response.status === 404) {
    return false;
  }
  await assertOk(response, `isRunning(${processInstanceId})`);
  return true;
}

/**
 * Operaton's REST API is eventually consistent: a correlated message, a
 * completed task, or a fired event may briefly leave the successor state
 * invisible to a query. Every observation polls until the predicate holds or the
 * timeout expires and then asserts on the last poll, so a genuine mismatch still
 * fails, just later.
 */
export async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  let value = await probe();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await probe();
  }
  return value;
}

/** The sorted definition keys of a set of active user tasks. */
export function activeTaskKeys(
  tasks: Array<{ taskDefinitionKey: string }>,
): string[] {
  return tasks.map((task) => task.taskDefinitionKey).sort();
}
