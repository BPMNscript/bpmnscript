// The fixture adapter covers deploy, start, task list, and task completion.
// Everything else here goes straight at restBaseUrl().
//
// Every e2e file shares one engine. The deploy sweep puts each of its rows,
// every example among them, in a tenant of its own, and every other file
// deploys into the default tenant, so each query, message and signal below
// that is not already pinned to an instance says `withoutTenantId`.

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

async function engineSend(
  fixture: FixtureAdapter,
  resource: string,
  body: unknown,
  context: string,
  method: 'POST' | 'PUT' = 'POST',
): Promise<Response> {
  const response = await fetch(fixture.restBaseUrl() + resource, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await assertOk(response, context);
  return response;
}

export async function correlateMessage(
  fixture: FixtureAdapter,
  messageName: string,
  processInstanceId: string,
): Promise<void> {
  await engineSend(
    fixture,
    '/engine-rest/message',
    { messageName, processInstanceId },
    `correlateMessage(${messageName})`,
  );
}

// With no instance named, the engine matches the message against every
// deployed message start event; `resultEnabled` makes the response name the
// instance it created.
export async function startByMessage(
  fixture: FixtureAdapter,
  messageName: string,
): Promise<string> {
  const response = await engineSend(
    fixture,
    '/engine-rest/message',
    { messageName, resultEnabled: true, withoutTenantId: true },
    `startByMessage(${messageName})`,
  );
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
  await engineSend(
    fixture,
    '/engine-rest/signal',
    { name, withoutTenantId: true },
    `broadcastSignal(${name})`,
  );
}

export interface EngineJob {
  id: string;
  processDefinitionKey: string;
  jobDefinitionId: string;
  suspended: boolean;
}

// A timer start event parks a job at deployment, with no instance behind it.
export async function jobsOf(
  fixture: FixtureAdapter,
  processDefinitionKey: string,
): Promise<EngineJob[]> {
  return engineGet<EngineJob[]>(
    fixture,
    `/engine-rest/job?withoutTenantId=true&processDefinitionKey=${encodeURIComponent(processDefinitionKey)}`,
    `jobsOf(${processDefinitionKey})`,
  );
}

export async function jobsOfInstance(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<EngineJob[]> {
  return engineGet<EngineJob[]>(
    fixture,
    `/engine-rest/job?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `jobsOfInstance(${processInstanceId})`,
  );
}

export interface JobDefinition {
  id: string;
  jobType: string;
  jobConfiguration: string;
}

// The engine creates one job definition per activity that needs a job, so an
// activity without an async continuation has none; a repeated activity is two
// activities to the engine, `<id>#multiInstanceBody` and `<id>`, each with its
// own.
export async function jobDefinitionsFor(
  fixture: FixtureAdapter,
  processDefinitionKey: string,
  activityId: string,
): Promise<JobDefinition[]> {
  return engineGet<JobDefinition[]>(
    fixture,
    `/engine-rest/job-definition?withoutTenantId=true&processDefinitionKey=${encodeURIComponent(processDefinitionKey)}&activityIdIn=${encodeURIComponent(activityId)}`,
    `jobDefinitionsFor(${activityId})`,
  );
}

// A suspended job definition stamps its state onto jobs created later too,
// which is what holds an async continuation still long enough to observe
// instead of racing the job executor for it.
export async function setJobDefinitionSuspended(
  fixture: FixtureAdapter,
  jobDefinitionId: string,
  suspended: boolean,
): Promise<void> {
  await engineSend(
    fixture,
    `/engine-rest/job-definition/${encodeURIComponent(jobDefinitionId)}/suspended`,
    { suspended, includeJobs: true },
    `setJobDefinitionSuspended(${jobDefinitionId}, ${suspended})`,
    'PUT',
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
    `/engine-rest/history/process-instance?withoutTenantId=true&processDefinitionKey=${encodeURIComponent(processDefinitionKey)}`,
    `historicInstances(${processDefinitionKey})`,
  );
}

export interface HistoricVariable {
  name: string;
  value: unknown;
}

// Running and finished alike: the runtime forgets an instance's variables the
// moment it ends, and history is where a finished step's output is read.
export async function historicVariables(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<HistoricVariable[]> {
  return engineGet<HistoricVariable[]>(
    fixture,
    `/engine-rest/history/variable-instance?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `historicVariables(${processInstanceId})`,
  );
}

export interface HistoricActivityInstance {
  activityId: string;
  endTime: string | null;
  canceled: boolean;
}

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

// Which trigger an instance is parked on: a message catch holds a `message`
// subscription while the token sits at it, gone once the message is consumed.
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

// The single-instance resource, not the collection query: the runtime
// collection has no `processInstanceId` filter, so a query built on that name
// answers for every instance the shared engine holds. A 404 means the
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

// Operaton's REST API is eventually consistent, so the state after a correlated
// message, a completed task, or a fired event can stay invisible to a query for
// a moment. Polls, then hands back the last value read, so a real mismatch
// still fails the caller's assertion, just later.
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

// Returns rather than throws on timeout, so an instance that never finishes
// fails the caller's assertion instead of hanging.
export async function waitUntilFinished(
  fixture: FixtureAdapter,
  processInstanceId: string,
  timeoutMs?: number,
): Promise<boolean> {
  const running = await waitFor(
    () => isRunning(fixture, processInstanceId),
    (stillRunning) => !stillRunning,
    timeoutMs,
  );
  return !running;
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

// Completing a task needs its runtime id: the definition key names the modeled
// activity, the id names this instance's token.
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

// The adapter's start carries variables alone. A business key is what a fetch
// can filter a topic by (FetchExternalTasksDto names no process instance), so
// a journey that must lock its own instance's task starts through this.
export async function startWithBusinessKey(
  fixture: FixtureAdapter,
  processDefinitionKey: string,
  businessKey: string,
): Promise<string> {
  const response = await engineSend(
    fixture,
    `/engine-rest/process-definition/key/${encodeURIComponent(processDefinitionKey)}/start`,
    { businessKey },
    `startWithBusinessKey(${processDefinitionKey})`,
  );
  return ((await response.json()) as { id: string }).id;
}

// The one worker id every lock, completion and failure below names: the engine
// hands a locked task back only to the worker holding its lock.
const WORKER_ID = 'e2e-worker';

export interface LockedExternalTask {
  id: string;
  processInstanceId: string;
  priority: number;
  extensionProperties: Record<string, string>;
}

// `includeExtensionProperties` is what puts the task's `operaton:property` map
// on the answer; `priority` comes regardless.
export async function fetchAndLock(
  fixture: FixtureAdapter,
  topicName: string,
  businessKey: string,
): Promise<LockedExternalTask> {
  const locked = await waitFor(
    async () => {
      const response = await engineSend(
        fixture,
        '/engine-rest/external-task/fetchAndLock',
        {
          workerId: WORKER_ID,
          maxTasks: 1,
          topics: [
            {
              topicName,
              businessKey,
              lockDuration: 60_000,
              includeExtensionProperties: true,
            },
          ],
        },
        `fetchAndLock(${topicName})`,
      );
      return (await response.json()) as LockedExternalTask[];
    },
    (tasks) => tasks.length > 0,
  );
  if (locked[0] === undefined) {
    throw new Error(
      `no external task on '${topicName}' for business key ${businessKey}`,
    );
  }
  return locked[0];
}

export async function completeExternalTask(
  fixture: FixtureAdapter,
  taskId: string,
): Promise<void> {
  await engineSend(
    fixture,
    `/engine-rest/external-task/${encodeURIComponent(taskId)}/complete`,
    { workerId: WORKER_ID },
    `completeExternalTask(${taskId})`,
  );
}

export interface ExternalTaskFailure {
  errorMessage: string;
  errorDetails?: string;
  retries: number;
}

// `ExternalTaskEntity.failed` runs the task's error mappings against the
// message before it touches the retries, so a matching message never leaves a
// task behind.
export async function failExternalTask(
  fixture: FixtureAdapter,
  taskId: string,
  failure: ExternalTaskFailure,
): Promise<void> {
  await engineSend(
    fixture,
    `/engine-rest/external-task/${encodeURIComponent(taskId)}/failure`,
    { workerId: WORKER_ID, ...failure },
    `failExternalTask(${taskId})`,
  );
}

export interface ExternalTask {
  id: string;
  topicName: string;
  errorMessage: string | null;
  retries: number | null;
}

export async function externalTasksOf(
  fixture: FixtureAdapter,
  processInstanceId: string,
): Promise<ExternalTask[]> {
  return engineGet<ExternalTask[]>(
    fixture,
    `/engine-rest/external-task?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    `externalTasksOf(${processInstanceId})`,
  );
}

// Returns the raw response: the form service answers a refused submission
// with a non-2xx whose body names the field or value it refused, and that is
// what a caller asserts on.
export async function submitTaskForm(
  fixture: FixtureAdapter,
  taskId: string,
  variables: Record<string, string>,
): Promise<Response> {
  return fetch(
    `${fixture.restBaseUrl()}/engine-rest/task/${encodeURIComponent(taskId)}/submit-form`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables: Object.fromEntries(
          Object.entries(variables).map(([key, value]) => [key, { value }]),
        ),
      }),
    },
  );
}

export interface IdentityLink {
  type: string;
  userId: string | null;
  groupId: string | null;
}

// What `operaton:assignee`, `operaton:candidateUsers` and
// `operaton:candidateGroups` resolve to at runtime.
export async function identityLinksOf(
  fixture: FixtureAdapter,
  taskId: string,
): Promise<IdentityLink[]> {
  return engineGet<IdentityLink[]>(
    fixture,
    `/engine-rest/task/${encodeURIComponent(taskId)}/identity-links`,
    `identityLinksOf(${taskId})`,
  );
}
