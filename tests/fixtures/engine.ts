import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    engineRestUrl: string;
  }
}

const ENGINE_IMAGE = 'bpmnscript-engine:e2e';

const SPRING_BOOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../examples/spring-boot',
);

// Global setup of the e2e project: one engine for every e2e file. A fixed tag
// makes a rebuild move the tag instead of leaving one more anonymous image
// behind per run.
export async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  if (process.env.SKIP_DOCKER_TESTS === 'true') {
    return undefined;
  }
  await GenericContainer.fromDockerfile(SPRING_BOOT_DIR).build(ENGINE_IMAGE, {
    deleteOnExit: false,
  });
  const container = await new GenericContainer(ENGINE_IMAGE)
    .withExposedPorts(8080)
    // Keep the default short read timeout: a probe sent before Spring Boot
    // listens can hang for the whole timeout instead of failing fast, which
    // with a two-minute timeout held every boot for two minutes.
    .withWaitStrategy(
      Wait.forHttp('/engine-rest/engine', 8080).forStatusCode(200),
    )
    .withStartupTimeout(120_000)
    .start();
  project.provide(
    'engineRestUrl',
    `http://${container.getHost()}:${container.getMappedPort(8080)}`,
  );
  return async () => {
    await container.stop();
  };
}
