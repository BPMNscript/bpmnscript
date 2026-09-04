import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { assertOk } from '../../helpers/engine-rest.js';
import type { ActiveTask, FixtureAdapter } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vitest transforms TS in place, so import.meta.url resolves to this source file.
const SPRING_BOOT_DIR = path.resolve(
  __dirname,
  '../../../examples/spring-boot',
);

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
  private container: StartedTestContainer | null = null;
  private _restBaseUrl = '';

  async start(): Promise<void> {
    const container =
      await GenericContainer.fromDockerfile(SPRING_BOOT_DIR).build();

    this.container = await container
      .withExposedPorts(8080)
      .withWaitStrategy(
        Wait.forHttp('/engine-rest/engine', 8080)
          .forStatusCode(200)
          .withReadTimeout(120_000),
      )
      .withStartupTimeout(120_000)
      .start();

    const host = this.container.getHost();
    const port = this.container.getMappedPort(8080);
    this._restBaseUrl = `http://${host}:${port}`;
  }

  restBaseUrl(): string {
    return this._restBaseUrl;
  }

  async stop(): Promise<void> {
    if (this.container) {
      await this.container.stop();
      this.container = null;
      this._restBaseUrl = '';
    }
  }

  async deploy(
    xmlPath: string,
    deploymentName = path.basename(xmlPath, '.bpmn'),
  ): Promise<{ deploymentId: string }> {
    const form = new FormData();
    form.append('deployment-name', deploymentName);

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

// A cold Docker build takes up to 120 seconds.
export async function start(): Promise<FixtureAdapter> {
  const adapter = new SpringBootAdapter();
  await adapter.start();
  return adapter;
}
