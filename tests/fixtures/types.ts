// One API for a deployment fixture, so an integration test is written once and
// can run against another runtime later.
export interface ActiveTask {
  id: string;
  name: string;
  taskDefinitionKey: string;
  assignee?: string;
}

export interface FixtureAdapter {
  // Returns when the runtime accepts deployments.
  start(): Promise<void>;

  // A tenant id isolates the deployment's message-start subscriptions from
  // every other tenant's; without one the deployment is shared.
  deploy(
    xmlPath: string,
    deploymentName?: string,
    tenantId?: string,
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
