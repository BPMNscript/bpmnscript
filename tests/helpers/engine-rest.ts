// The fixture adapter covers deploy, start, task list, and task completion.
// Everything else here goes straight at restBaseUrl().

import type { ActiveTask, FixtureAdapter } from '../fixtures/index.js';

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

export async function engineGet<T>(
  fixture: FixtureAdapter,
  resource: string,
  context: string,
): Promise<T> {
  const response = await fetch(fixture.restBaseUrl() + resource);
  await assertOk(response, context);
  return (await response.json()) as T;
}

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

// Running and finished alike.
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

// The engine's record of which trigger an instance is parked on. A message
// intermediate catch holds an active `message` subscription while the token
// sits at it, and the subscription goes once the message is consumed.
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

// Asks the single-instance resource, not the collection query: the runtime
// collection has no processInstanceId filter, so a query built on that name
// answers for every other instance the shared engine holds. A 404 means the
// instance left the runtime, which for a process nothing cancels means it
// ran to its end.
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

// Operaton's REST API is eventually consistent: after a correlated message, a
// completed task, or a fired event, the successor state can stay invisible to a
// query for a moment. Poll, then assert on the last value read, so a real
// mismatch still fails, just later.
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

export async function waitForTasks(
  fixture: FixtureAdapter,
  processInstanceId: string,
  predicate: (tasks: ActiveTask[]) => boolean,
  timeoutMs = 10_000,
): Promise<ActiveTask[]> {
  return waitFor(
    () => fixture.getActiveTasks(processInstanceId),
    predicate,
    timeoutMs,
  );
}

export function activeTaskKeys(
  tasks: Array<{ taskDefinitionKey: string }>,
): string[] {
  return tasks.map((task) => task.taskDefinitionKey).sort();
}
