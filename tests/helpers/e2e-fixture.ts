import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { astToIr } from '@bpmn-script/transform';
import type { BpmnProcess } from '@bpmn-script/transform';

import { buildExample, startFixture } from '../fixtures/index.js';
import type { FixtureAdapter } from '../fixtures/index.js';
import { parse } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKIP_DOCKER = process.env.SKIP_DOCKER_TESTS === 'true';

// A cold image build plus Spring Boot startup needs this much.
export const ENGINE_BOOT_TIMEOUT_MS = 300_000;

export function dslPath(name: string): string {
  return resolve(
    __dirname,
    `../../examples/spring-boot/processes/${name}.bpmnscript`,
  );
}

// Lets a suite pin a structural fact whether or not an engine is reachable.
export async function irOfExample(name: string): Promise<BpmnProcess> {
  const document = await parse(readFileSync(dslPath(name), 'utf-8'));
  expect(
    document.parseResult.parserErrors,
    `parser errors in ${name}.bpmnscript`,
  ).toHaveLength(0);
  return astToIr(document.parseResult.value);
}

export async function deployExamples(
  ...names: string[]
): Promise<FixtureAdapter> {
  const built = names.map((name) => {
    const xmlPath = resolve(__dirname, `../../out/${name}.bpmn`);
    buildExample(dslPath(name), xmlPath);
    return { name, xmlPath };
  });

  const fixture = await startFixture('spring-boot');
  for (const { name, xmlPath } of built) {
    const { deploymentId } = await fixture.deploy(xmlPath, `${name}-test`);
    expect(deploymentId).toBeTruthy();
  }
  return fixture;
}
