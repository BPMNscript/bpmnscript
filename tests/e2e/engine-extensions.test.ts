// A listener the engine never invokes, an input parameter it ignores, an
// injected field that never reaches its delegate, and an `asyncBefore` that
// does not break the transaction all compile to the same well-formed file, so
// no XML-against-XML test can tell them apart. This suite boots a real Operaton
// and reads back what it did: the markers the listeners wrote, the values the
// engine set on each bean before invoking it, the values the service task
// resolved from its mapped parameters, the form reference it parsed off the
// user task, and the job the async continuation parked the token on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  engineGet,
  historicActivities,
  isRunning,
  jobDefinitionsFor,
  jobsOfInstance,
  setJobDefinitionSuspended,
  waitFor,
  waitUntilFinished,
} from '../helpers/engine-rest.js';

const PROCESS_KEY = 'engine-extensions';

const ASYNC_ACTIVITY = 'SettleExtensions';

const LISTENER_LOG = 'listenerLog';

interface EngineVariable {
  value: unknown;
}

interface TransitionInstance {
  activityId: string;
}

// What `GET /task/{id}/form` reports: a task naming a form by key fills `key`,
// one naming a deployed form fills `operatonFormRef`, and never both.
interface TaskForm {
  key: string | null;
  operatonFormRef: { key: string; binding: string; version: number } | null;
}

interface ActivityInstanceTree {
  childTransitionInstances: TransitionInstance[];
}

describe.skipIf(SKIP)(
  'E2E: the Operaton extension surface on Spring Boot Operaton',
  () => {
    let fixture: FixtureAdapter;

    function variablesOf(
      processInstanceId: string,
    ): Promise<Record<string, EngineVariable>> {
      return engineGet<Record<string, EngineVariable>>(
        fixture,
        `/engine-rest/process-instance/${encodeURIComponent(processInstanceId)}/variables`,
        `variablesOf(${processInstanceId})`,
      );
    }

    async function variableValue(
      processInstanceId: string,
      name: string,
    ): Promise<unknown> {
      return (await variablesOf(processInstanceId))[name]?.value;
    }

    // In the order the engine fired them. An instance whose listeners never ran
    // holds no such variable and gets an empty list, so the assertion that
    // follows reports the missing marker rather than a read error.
    async function listenerMarkers(
      processInstanceId: string,
    ): Promise<string[]> {
      const recorded = await variableValue(processInstanceId, LISTENER_LOG);
      return typeof recorded === 'string' ? recorded.split(',') : [];
    }

    // An async continuation parks on a transition: the token has left the
    // previous activity and has not entered the next one.
    async function transitionActivityIds(
      processInstanceId: string,
    ): Promise<string[]> {
      const tree = await engineGet<ActivityInstanceTree>(
        fixture,
        `/engine-rest/process-instance/${encodeURIComponent(processInstanceId)}/activity-instances`,
        `transitionActivityIds(${processInstanceId})`,
      );
      return tree.childTransitionInstances.map(
        (transition) => transition.activityId,
      );
    }

    // Returns once the instance reaches the user task, the one wait state on the
    // path. Everything before it runs in the starting transaction, so the
    // listener markers and mapped parameters are settled when this resolves.
    async function startAndReachUserTask(): Promise<{
      processInstanceId: string;
      taskId: string;
    }> {
      const { processInstanceId } = await fixture.startProcess(PROCESS_KEY, {});
      const tasks = await waitFor(
        () => fixture.getActiveTasks(processInstanceId),
        (active) => active.length > 0,
      );
      expect(
        tasks.map((task) => task.taskDefinitionKey),
        `instance ${processInstanceId} never reached the user task`,
      ).toEqual(['ConfirmMarkers']);
      return { processInstanceId, taskId: tasks[0]!.id };
    }

    beforeAll(async () => {
      fixture = await deployExamples('engine-extensions');
    }, ENGINE_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await fixture?.stop();
    }, ENGINE_STOP_TIMEOUT_MS);

    it('fires both execution listeners of a service task, its delegate, and the task listener, in that order', async () => {
      const { processInstanceId } = await startAndReachUserTask();

      const markers = await listenerMarkers(processInstanceId);

      // The injected value is the third segment and is dropped here, so this
      // asserts what the engine invoked and the test below what it set.
      expect(
        markers.map((marker) => marker.split(':').slice(0, 2).join(':')),
      ).toEqual([
        'RecordMarkers:start',
        'RecordMarkers:execute',
        'RecordMarkers:end',
        'ConfirmMarkers:create',
      ]);
    }, 60_000);

    it('sets each injected field on the bean it was declared under, evaluating an expression and leaving a literal alone', async () => {
      const { processInstanceId } = await startAndReachUserTask();

      const markers = await listenerMarkers(processInstanceId);

      // Null where the binding carried no field, so a field that leaked onto
      // the wrong bean fails as loudly as one that never arrived. The start
      // listener's value is the instance id the expression resolved to, which
      // nothing in the deployment could have carried: had the engine been
      // handed the literal instead, the marker would read `${...}` verbatim.
      // The delegate's value runs the reverse check: it holds a `${...}` the
      // engine would evaluate to `recorded-2` had it arrived in the expression
      // slot, so it reads back verbatim only while the literal slot is used.
      expect(markers.map((marker) => marker.split(':')[2] ?? null)).toEqual([
        processInstanceId,
        'recorded-${1+1}',
        null,
        'confirmed',
      ]);
    }, 60_000);

    it('parses the form reference off the user task and reports it with its binding and version', async () => {
      const { taskId } = await startAndReachUserTask();

      const form = await engineGet<TaskForm>(
        fixture,
        `/engine-rest/task/${encodeURIComponent(taskId)}/form`,
        `formOf(${taskId})`,
      );

      // Read back off the engine's own parse of the deployment, which is the
      // only place the three `operaton:formRef*` attributes are ever read: a
      // reference missing its binding fails the deployment outright.
      expect(form.operatonFormRef).toEqual({
        key: 'confirm-markers',
        binding: 'version',
        version: 1,
      });
      expect(form.key).toBeNull();
    }, 60_000);

    it('maps a scalar and a map input into the service task and an output back onto the instance', async () => {
      const { processInstanceId } = await startAndReachUserTask();

      const variables = await variablesOf(processInstanceId);

      // The service task's expression resolved the scalar parameter and both
      // entries of the map, so the engine put them in the activity's scope.
      expect(variables['parameterEcho']?.value).toBe(
        'match every receipt against the trip dates/expenses-l2/high',
      );

      expect(variables['mappedDesk']?.value).toBe('expenses-l2');

      // An input mapping makes its activity a variable scope, so neither input
      // may survive as an instance variable. If they leaked, the values arrived
      // as ordinary process variables and the assertions above proved nothing.
      expect(Object.keys(variables).sort()).toEqual([
        LISTENER_LOG,
        'mappedDesk',
        'parameterEcho',
      ]);
    }, 60_000);

    it('fires the create task listener before the user task is completed', async () => {
      const { processInstanceId, taskId } = await startAndReachUserTask();

      // Read while the task is still open: a listener that only looked like it
      // fired because completion triggered something else would not show yet.
      const tasksBefore = await fixture.getActiveTasks(processInstanceId);
      expect(tasksBefore.map((task) => task.taskDefinitionKey)).toEqual([
        'ConfirmMarkers',
      ]);
      expect(await listenerMarkers(processInstanceId)).toContain(
        'ConfirmMarkers:create:confirmed',
      );

      await fixture.completeTask(taskId);

      expect(await waitUntilFinished(fixture, processInstanceId, 30_000)).toBe(
        true,
      );

      const ranActivities = (
        await historicActivities(fixture, processInstanceId)
      ).map((activity) => activity.activityId);
      expect(ranActivities).toContain('ConfirmMarkers');
      expect(ranActivities).toContain('ExtensionsRecorded');
    }, 60_000);

    it('parks the instance on a job at the async activity until the job executor runs it', async () => {
      // The engine's own reading of `asyncBefore`: this job definition exists
      // only because the deployment declared a transaction boundary there.
      const jobDefinitions = await jobDefinitionsFor(
        fixture,
        PROCESS_KEY,
        ASYNC_ACTIVITY,
      );
      expect(
        jobDefinitions,
        `no job definition for ${ASYNC_ACTIVITY}, so the engine saw no async continuation`,
      ).toHaveLength(1);
      const jobDefinition = jobDefinitions[0]!;
      expect(jobDefinition.jobType).toBe('async-continuation');
      expect(jobDefinition.jobConfiguration).toBe('async-before');

      // Suspend first: otherwise the job executor runs the job within
      // milliseconds of the transaction committing and the parked state is gone.
      await setJobDefinitionSuspended(fixture, jobDefinition.id, true);

      const { processInstanceId, taskId } = await startAndReachUserTask();
      await fixture.completeTask(taskId);

      // Completing the task returned without running the async activity: the
      // token left the user task and stopped on the transition into it.
      expect(await isRunning(fixture, processInstanceId)).toBe(true);
      expect(await transitionActivityIds(processInstanceId)).toEqual([
        ASYNC_ACTIVITY,
      ]);

      const parkedJobs = await jobsOfInstance(fixture, processInstanceId);
      expect(parkedJobs).toHaveLength(1);
      expect(parkedJobs[0]!.jobDefinitionId).toBe(jobDefinition.id);
      expect(parkedJobs[0]!.suspended).toBe(true);

      const beforeActivation = (
        await historicActivities(fixture, processInstanceId)
      ).map((activity) => activity.activityId);
      expect(beforeActivation).toContain('ConfirmMarkers');
      expect(beforeActivation).not.toContain(ASYNC_ACTIVITY);

      await setJobDefinitionSuspended(fixture, jobDefinition.id, false);

      expect(await waitUntilFinished(fixture, processInstanceId, 30_000)).toBe(
        true,
      );

      const afterActivation = (
        await historicActivities(fixture, processInstanceId)
      ).map((activity) => activity.activityId);
      expect(afterActivation).toContain(ASYNC_ACTIVITY);
      expect(afterActivation).toContain('ExtensionsRecorded');
    }, 90_000);
  },
);
