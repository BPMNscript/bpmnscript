/**
 * Generic interface for Operaton runtime fixture adapters.
 *
 * Each implementation wraps a particular deployment mode (Spring Boot,
 * external tasks, standalone) behind a uniform API so integration tests
 * can be written once and run against any mode.
 */
export interface FixtureAdapter {
  /** Bring the runtime up; returns when it is ready to accept deployments. */
  start(): Promise<void>;

  /** Deploy a BPMN XML file (path on disk) under a given deployment name. */
  deploy(
    xmlPath: string,
    deploymentName?: string,
  ): Promise<{ deploymentId: string }>;

  /** Start a process instance by processDefinitionKey with optional variables. */
  startProcess(
    key: string,
    variables?: Record<string, unknown>,
  ): Promise<{ processInstanceId: string }>;

  /** List currently active user tasks for a process instance. */
  getActiveTasks(processInstanceId: string): Promise<
    Array<{
      id: string;
      name: string;
      taskDefinitionKey: string;
      assignee?: string;
    }>
  >;

  /**
   * Complete a user task by id, optionally setting process variables in the
   * same call. Required to drive a process past user-task boundaries from
   * an integration test (otherwise the process pauses at the first user
   * task and downstream nodes are never reached).
   */
  completeTask(
    taskId: string,
    variables?: Record<string, unknown>,
  ): Promise<void>;

  /** REST base URL for callers that need direct access. */
  restBaseUrl(): string;

  /** Tear down the runtime and clean up resources. */
  stop(): Promise<void>;
}

/** The supported fixture deployment modes. */
export type FixtureMode = 'spring-boot' | 'external-tasks' | 'standalone';
