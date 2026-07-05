/**
 * Spring Boot fixture adapter for BPMNscript integration tests.
 *
 * Builds the `examples/spring-boot/Dockerfile` via testcontainers, waits
 * for the Operaton REST API to become healthy, and exposes the full
 * `FixtureAdapter` contract backed by real REST calls to the running engine.
 *
 * Node 20+ built-in `fetch` is used throughout — no extra HTTP library needed.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import type { FixtureAdapter } from '../types.js';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to `examples/spring-boot/` relative to this file.
 *
 * Source location: `tests/fixtures/adapters/spring-boot.ts`. Vitest transforms
 * TS in-place, so `import.meta.url` resolves to the source file. Going 3 levels
 * up lands at the repo root, then `examples/spring-boot` is the Dockerfile dir.
 */
const SPRING_BOOT_DIR = path.resolve(
  __dirname,
  '../../../examples/spring-boot',
);

// ---------------------------------------------------------------------------
// Operaton variable type inference
// ---------------------------------------------------------------------------

type OperatonVariableType = 'Long' | 'String' | 'Boolean' | 'Double';

interface OperatonVariable {
  value: unknown;
  type: OperatonVariableType;
}

/**
 * Convert a flat `Record<string, unknown>` into the Operaton REST API's
 * `{ value, type }` variable bag.  Supports the primitive types the tests
 * require; any unrecognised type falls back to `String`.
 */
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

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

/** Build a URL from the base and a relative path segment. */
function buildUrl(base: string, ...segments: string[]): string {
  return base + segments.join('');
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Operaton REST error [${context}]: HTTP ${response.status} — ${body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SpringBootAdapter implementation
// ---------------------------------------------------------------------------

class SpringBootAdapter implements FixtureAdapter {
  private container: StartedTestContainer | null = null;
  private _restBaseUrl = '';

  // ----------------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------------

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

  // ----------------------------------------------------------------------
  // Deployments
  // ----------------------------------------------------------------------

  /**
   * POST the BPMN XML file to `/engine-rest/deployment/create` as
   * multipart/form-data.
   *
   * The Operaton REST API expects:
   *   - A `deployment-name` text field.
   *   - One or more BPMN files as file parts.
   */
  async deploy(
    xmlPath: string,
    deploymentName = path.basename(xmlPath, '.bpmn'),
  ): Promise<{ deploymentId: string }> {
    // Node 20 FormData + Blob support is sufficient — no extra library needed.
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
      buildUrl(this._restBaseUrl, '/engine-rest/deployment/create'),
      { method: 'POST', body: form },
    );

    await assertOk(response, 'deploy');

    const json = (await response.json()) as { id: string };
    return { deploymentId: json.id };
  }

  // ----------------------------------------------------------------------
  // Process instances
  // ----------------------------------------------------------------------

  /**
   * POST to `/engine-rest/process-definition/key/{key}/start`.
   *
   * Converts the flat variable map to Operaton's typed `{ value, type }`
   * shape before serialising to JSON.
   */
  async startProcess(
    key: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ processInstanceId: string }> {
    const response = await fetch(
      buildUrl(
        this._restBaseUrl,
        `/engine-rest/process-definition/key/${key}/start`,
      ),
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

  // ----------------------------------------------------------------------
  // Task queries
  // ----------------------------------------------------------------------

  /** GET `/engine-rest/task?processInstanceId={id}`. */
  async getActiveTasks(processInstanceId: string): Promise<
    Array<{
      id: string;
      name: string;
      taskDefinitionKey: string;
      assignee?: string;
    }>
  > {
    const response = await fetch(
      buildUrl(
        this._restBaseUrl,
        `/engine-rest/task?processInstanceId=${encodeURIComponent(processInstanceId)}`,
      ),
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

  // ----------------------------------------------------------------------
  // Task completion
  // ----------------------------------------------------------------------

  /**
   * POST `/engine-rest/task/{id}/complete` with optional process variables.
   *
   * Operaton's task-complete endpoint accepts the same `{value, type}` shape
   * as `startProcess`, so the same conversion helper is reused. A successful
   * call drives the engine forward; control returns once the post-completion
   * transitions have run synchronously (service-task delegates included).
   */
  async completeTask(
    taskId: string,
    variables: Record<string, unknown> = {},
  ): Promise<void> {
    const response = await fetch(
      buildUrl(
        this._restBaseUrl,
        `/engine-rest/task/${encodeURIComponent(taskId)}/complete`,
      ),
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and start a Spring Boot Operaton fixture.
 *
 * Builds the Docker image from `examples/spring-boot/Dockerfile` and waits
 * until the Operaton engine REST endpoint responds 200.  On cold build this
 * can take up to 120 seconds; subsequent runs use Docker's layer cache.
 */
export async function start(): Promise<FixtureAdapter> {
  const adapter = new SpringBootAdapter();
  await adapter.start();
  return adapter;
}
