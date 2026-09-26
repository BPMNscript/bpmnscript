import * as path from 'node:path';
import { inject } from 'vitest';
import { assertOk } from '../../helpers/engine-rest.js';
import type { ActiveTask, FixtureAdapter } from '../types.js';

type OperatonVariableType = 'Long' | 'String' | 'Boolean' | 'Double';

interface OperatonVariable {
  value: unknown;
  type: OperatonVariableType;
}

// Operaton's `{ value, type }` variable bag. Only the primitives the tests need
// are inferred; anything else lands as String.
function toOperatonVariables(
  flat: Record<string, unknown>,
): Record<string, OperatonVariable> {
  const result: Record<string, OperatonVariable> = {};
  for (const [key, value] of Object.entries(flat)) {
    let type: OperatonVariableType;
    if (typeof value === 'number') {
      type = Number.isInteger(value) ? 'Long' : 'Double';
    } else if (typeof value === 'boolean') {
      type = 'Boolean';
    } else {
      type = 'String';
    }
    result[key] = { value, type };
  }
  return result;
}

class SpringBootAdapter implements FixtureAdapter {
  // Started once per run by the e2e global setup and shared by every file.
  private readonly _restBaseUrl = inject('engineRestUrl');

  restBaseUrl(): string {
    return this._restBaseUrl;
  }

  async deploy(
    xmlPath: string,
    deploymentName = path.basename(xmlPath, '.bpmn'),
    tenantId?: string,
  ): Promise<{ deploymentId: string }> {
    const form = new FormData();
    form.append('deployment-name', deploymentName);
    // The part name DeploymentRestServiceImpl.createDeployment reads.
    if (tenantId !== undefined) {
      form.append('tenant-id', tenantId);
    }

    const xmlBytes = await import('node:fs/promises').then((fs) =>
      fs.readFile(xmlPath),
    );
    form.append(
      path.basename(xmlPath),
      new Blob([xmlBytes], { type: 'application/xml' }),
      path.basename(xmlPath),
    );

    const response = await fetch(
      `${this._restBaseUrl}/engine-rest/deployment/create`,
      { method: 'POST', body: form },
    );

    await assertOk(response, 'deploy');

    const json = (await response.json()) as { id: string };
    return { deploymentId: json.id };
  }

  async startProcess(
    key: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ processInstanceId: string }> {
    const response = await fetch(
      `${this._restBaseUrl}/engine-rest/process-definition/key/${key}/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variables: toOperatonVariables(variables),
        }),
      },
    );

    await assertOk(response, `startProcess(${key})`);

    const json = (await response.json()) as { id: string };
    return { processInstanceId: json.id };
  }

  async getActiveTasks(processInstanceId: string): Promise<ActiveTask[]> {
    const response = await fetch(
      `${this._restBaseUrl}/engine-rest/task?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    );

    await assertOk(response, `getActiveTasks(${processInstanceId})`);

    const json = (await response.json()) as Array<{
      id: string;
      name: string;
      taskDefinitionKey: string;
      assignee: string | null;
    }>;

    return json.map((task) => ({
      id: task.id,
      name: task.name,
      taskDefinitionKey: task.taskDefinitionKey,
      ...(task.assignee !== null && task.assignee !== undefined
        ? { assignee: task.assignee }
        : {}),
    }));
  }

  // Returns once the post-completion transitions have run synchronously,
  // service-task delegates included.
  async completeTask(
    taskId: string,
    variables: Record<string, unknown> = {},
  ): Promise<void> {
    const response = await fetch(
      `${this._restBaseUrl}/engine-rest/task/${encodeURIComponent(taskId)}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variables: toOperatonVariables(variables),
        }),
      },
    );

    await assertOk(response, `completeTask(${taskId})`);
  }
}

export function start(): FixtureAdapter {
  return new SpringBootAdapter();
}
