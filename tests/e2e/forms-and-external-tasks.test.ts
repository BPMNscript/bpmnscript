import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { irToXml, xmlToIr } from '@bpmn-script/transform';

import type { FixtureAdapter } from '../fixtures/index.js';
import {
  deployExamples,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_STOP_TIMEOUT_MS,
  SKIP_DOCKER as SKIP,
} from '../helpers/e2e-fixture.js';
import {
  completeExternalTask,
  externalTasksOf,
  failExternalTask,
  fetchAndLock,
  historicActivities,
  identityLinksOf,
  isRunning,
  startWithBusinessKey,
  submitTaskForm,
  waitForTaskId,
  waitForTaskKeys,
  waitUntilFinished,
} from '../helpers/engine-rest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHARGE_KEY = 'card-charge';
const CHARGE_TOPIC = 'charge-card';
const PLAN_KEY = 'plan-selection';

// A user task assigned in BPMN's own resource roles beside one Operaton
// attribute, so the deployed links come from both readers the engine runs.
const ASSIGNMENT_KEY = 'assignment-import';
const ASSIGNMENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:operaton="http://operaton.org/schema/1.0/bpmn"
                  targetNamespace="http://example.com/assignment">
  <bpmn:process id="${ASSIGNMENT_KEY}" isExecutable="true">
    <bpmn:startEvent id="Opened" />
    <bpmn:userTask id="Review" name="Review the request" operaton:candidateGroups="finance">
      <bpmn:humanPerformer id="Lead">
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>demo</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:humanPerformer>
      <bpmn:potentialOwner id="Team">
        <bpmn:resourceAssignmentExpression>
          <bpmn:formalExpression>user(mary), managers</bpmn:formalExpression>
        </bpmn:resourceAssignmentExpression>
      </bpmn:potentialOwner>
    </bpmn:userTask>
    <bpmn:endEvent id="Closed" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Opened" targetRef="Review" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Review" targetRef="Closed" />
  </bpmn:process>
</bpmn:definitions>
`;

describe.skipIf(SKIP)('E2E: forms and external tasks on Operaton', () => {
  let fixture: FixtureAdapter;

  beforeAll(async () => {
    fixture = await deployExamples(CHARGE_KEY, PLAN_KEY);
  }, ENGINE_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
  }, ENGINE_STOP_TIMEOUT_MS);

  // One instance per journey, locked as a worker would lock it.
  async function startAndFetchCharge() {
    const businessKey = randomUUID();
    const processInstanceId = await startWithBusinessKey(
      fixture,
      CHARGE_KEY,
      businessKey,
    );
    const task = await fetchAndLock(fixture, CHARGE_TOPIC, businessKey);
    expect(task.processInstanceId).toBe(processInstanceId);
    return { processInstanceId, task };
  }

  it('a worker fetching the charge sees its priority and its properties, and completing it settles the charge', async () => {
    const { processInstanceId, task } = await startAndFetchCharge();
    expect(task.priority).toBe(42);
    expect(task.extensionProperties).toEqual({
      gateway: 'stripe',
      attempts: '3',
    });

    await completeExternalTask(fixture, task.id);

    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
    const visited = await historicActivities(fixture, processInstanceId);
    expect(visited.map((a) => a.activityId).sort()).toEqual([
      'ChargeCard',
      'OrderCharged',
      'OrderReceived',
    ]);
  }, 60_000);

  it('a failure whose message matches the mapping ends the charge through the declined handler', async () => {
    const { processInstanceId, task } = await startAndFetchCharge();

    await failExternalTask(fixture, task.id, {
      errorMessage: 'declined',
      errorDetails: 'issuer response 05',
      retries: 0,
    });

    expect(
      await waitForTaskKeys(
        fixture,
        processInstanceId,
        (keys) => keys.length > 0,
      ),
    ).toEqual(['ReviewDecline']);
    await fixture.completeTask(
      await waitForTaskId(fixture, processInstanceId, 'ReviewDecline'),
    );
    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
  }, 60_000);

  it('a failure whose message matches no mapping leaves the charge for a retry', async () => {
    const { processInstanceId, task } = await startAndFetchCharge();

    await failExternalTask(fixture, task.id, {
      errorMessage: 'timeout',
      retries: 1,
    });

    expect(await isRunning(fixture, processInstanceId)).toBe(true);
    expect(await fixture.getActiveTasks(processInstanceId)).toEqual([]);
    const remaining = await externalTasksOf(fixture, processInstanceId);
    expect(
      remaining.map(({ topicName, errorMessage, retries }) => ({
        topicName,
        errorMessage,
        retries,
      })),
    ).toEqual([
      { topicName: CHARGE_TOPIC, errorMessage: 'timeout', retries: 1 },
    ]);
  }, 60_000);

  it('the form service refuses the plan form without its required enum value and outside its values, and takes a listed one', async () => {
    const { processInstanceId } = await fixture.startProcess(PLAN_KEY, {});
    const taskId = await waitForTaskId(
      fixture,
      processInstanceId,
      'ChoosePlan',
    );

    const refused: Array<[Record<string, string>, string]> = [
      [{}, 'plan'],
      [{ plan: 'gold' }, 'gold'],
    ];
    for (const [variables, named] of refused) {
      const response = await submitTaskForm(fixture, taskId, variables);
      expect(response.ok, JSON.stringify(variables)).toBe(false);
      expect(await response.text()).toContain(named);
    }

    const accepted = await submitTaskForm(fixture, taskId, { plan: 'plus' });
    expect(accepted.ok, await accepted.text()).toBe(true);
    expect(await waitUntilFinished(fixture, processInstanceId)).toBe(true);
  }, 60_000);

  it("a task assigned in BPMN's own words deploys with the identity links the engine resolves from the source", async () => {
    const { ir, warnings } = await xmlToIr(ASSIGNMENT_BPMN);
    expect(ir.flowElements.find((el) => el.id === 'Review')).toEqual({
      kind: 'userTask',
      id: 'Review',
      name: 'Review the request',
      assignee: 'demo',
      candidateUsers: 'mary',
      candidateGroups: 'managers,finance',
    });
    expect(warnings.map((w) => [w.category, w.elementId])).toEqual([
      ['unmappedConstruct', 'Review'],
      ['unmappedConstruct', 'Review'],
    ]);

    const xmlPath = resolve(__dirname, `../../out/${ASSIGNMENT_KEY}.bpmn`);
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, await irToXml(ir));
    await fixture.deploy(xmlPath, `${ASSIGNMENT_KEY}-test`);

    const { processInstanceId } = await fixture.startProcess(
      ASSIGNMENT_KEY,
      {},
    );
    const taskId = await waitForTaskId(fixture, processInstanceId, 'Review');
    const links = (await identityLinksOf(fixture, taskId))
      .map(
        (link) =>
          `${link.type} ${
            link.userId === null
              ? `group ${link.groupId}`
              : `user ${link.userId}`
          }`,
      )
      .sort();
    expect(links).toEqual([
      'assignee user demo',
      'candidate group finance',
      'candidate group managers',
      'candidate user mary',
    ]);
  }, 60_000);
});
