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
      `Operaton REST error [${context}]: HTTP ${response.status}: ${body}`,
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

// A message with no instance to aim at starts one: the engine matches it
// against the message start events of every deployed definition.
// `resultEnabled` is what makes the response name the instance it created.
export async function startByMessage(
  fixture: FixtureAdapter,
  messageName: string,
): Promise<string> {
  const response = await fetch(fixture.restBaseUrl() + '/engine-rest/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageName, resultEnabled: true }),
  });
  await assertOk(response, `startByMessage(${messageName})`);
  const results = (await response.json()) as Array<{
    processInstance: { id: string };
  }>;
  const id = results[0]?.processInstance?.id;
  if (id === undefined) {
    throw new Error(`no instance started by message '${messageName}'`);
  }
  return id;
}

// Broadcast to every subscription in the engine, which is what a signal start
// event subscribes to at deployment.
export async function broadcastSignal(
  fixture: FixtureAdapter,
  name: string,
): Promise<void> {
  const response = await fetch(fixture.restBaseUrl() + '/engine-rest/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await assertOk(response, `broadcastSignal(${name})`);
}

export interface EngineJob {
  id: string;
  processDefinitionKey: string;
}

// A timer start event parks a job at deployment, with no instance behind it.
export async function jobsOf(
  fixture: FixtureAdapter,
  processDefinitionKey: string,
): Promise<EngineJob[]> {
  return engineGet<EngineJob[]>(
    fixture,
    `/engine-rest/job?processDefinitionKey=${encodeURIComponent(processDefinitionKey)}`,
    `jobsOf(${processDefinitionKey})`,
  );
}

export async function executeJob(
  fixture: FixtureAdapter,
  jobId: string,
): Promise<void> {
  const response = await fetch(
    `${fixture.restBaseUrl()}/engine-rest/job/${encodeURIComponent(jobId)}/execute`,
    { method: 'POST' },
  );
  await assertOk(response, `executeJob(${jobId})`);
}

export interface HistoricProcessInstance {
  id: string;
  processDefinitionKey: string;
  endTime: string | null;
}

// Running and finished alike, which is how an instance nothing points at is
// found: a broadcast signal and a fired timer job both create one without
// naming it in their response.
export async function historicInstances(
  fixture: FixtureAdapter,
  processDefinitionKey: string,
): Promise<HistoricProcessInstance[]> {
  return engineGet<HistoricProcessInstance[]>(
    fixture,
    `/engine-rest/history/process-instance?processDefinitionKey=${encodeURIComponent(processDefinitionKey)}`,
    `historicInstances(${processDefinitionKey})`,
  );
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

// The sorted definition keys of whatever is active once the predicate holds,
// for asserting which tasks a branch opened rather than acting on one of them.
export async function waitForTaskKeys(
  fixture: FixtureAdapter,
  processInstanceId: string,
  predicate: (keys: string[]) => boolean,
): Promise<string[]> {
  const tasks = await waitForTasks(fixture, processInstanceId, (t) =>
    predicate(activeTaskKeys(t)),
  );
  return activeTaskKeys(tasks);
}

// The runtime id of an active task, which completing one needs: the definition
// key names the modeled activity, the id names this instance's token.
export async function waitForTaskId(
  fixture: FixtureAdapter,
  processInstanceId: string,
  definitionKey: string,
): Promise<string> {
  const tasks = await waitForTasks(fixture, processInstanceId, (t) =>
    t.some((task) => task.taskDefinitionKey === definitionKey),
  );
  const match = tasks.find((task) => task.taskDefinitionKey === definitionKey);
  if (match === undefined) {
    throw new Error(
      `no active task '${definitionKey}' in instance ${processInstanceId}`,
    );
  }
  return match.id;
}

// Every activity the instance has visited, once the named one is among them.
export async function activityIdsIncluding(
  fixture: FixtureAdapter,
  processInstanceId: string,
  activityId: string,
): Promise<string[]> {
  const activities = await waitFor(
    () => historicActivities(fixture, processInstanceId),
    (list) => list.some((a) => a.activityId === activityId),
  );
  return activities.map((a) => a.activityId);
}
