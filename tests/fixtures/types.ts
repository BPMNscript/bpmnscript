// One uniform API over the deployment modes, so an integration test is written
// once and runs against any of them.
export interface ActiveTask {
  id: string;
  name: string;
  taskDefinitionKey: string;
  assignee?: string;
}

export interface FixtureAdapter {
  // Returns when the runtime accepts deployments.
  start(): Promise<void>;

  deploy(
    xmlPath: string,
    deploymentName?: string,
  ): Promise<{ deploymentId: string }>;

  startProcess(
    key: string,
    variables?: Record<string, unknown>,
  ): Promise<{ processInstanceId: string }>;

  getActiveTasks(processInstanceId: string): Promise<ActiveTask[]>;

  completeTask(
    taskId: string,
    variables?: Record<string, unknown>,
  ): Promise<void>;

  restBaseUrl(): string;

  stop(): Promise<void>;
}

export type FixtureMode = 'spring-boot' | 'external-tasks' | 'standalone';
