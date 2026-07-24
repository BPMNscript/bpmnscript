/**
 * Health check for the deployable `awaiting-confirmation` example: a request
 * that blocks at an intermediate message catch until an external system
 * correlates a confirmation back. This mirrors the "the deployable example
 * opens validator-clean" assertion carried by the other example health
 * checks (see `order-handling-example.test.ts`), and additionally pins the
 * `intermediateCatchEvent` node's shape in the desugared IR — the part of
 * the construct no amount of XML inspection alone would catch, since it is
 * the desugaring step that decides what an `await` even lowers to.
 *
 * The runtime property — the token actually pausing until the message
 * arrives — needs a real engine and is proven separately by the Docker-gated
 * `tests/e2e/awaiting-confirmation.test.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmptyFileSystem } from 'langium';
import { parseHelper, validationHelper } from 'langium/test';
import { createBpmnScriptServices } from '@bpmn-script/language';
import type { Model } from '@bpmn-script/language';

import { astToIr } from '@bpmn-script/transform';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXAMPLE_PATH = resolve(
  __dirname,
  '../examples/spring-boot/processes/awaiting-confirmation.bpmnscript',
);

let parse: ReturnType<typeof parseHelper<Model>>;
let validate: ReturnType<typeof validationHelper<Model>>;
let exampleSrc: string;

beforeAll(async () => {
  const services = createBpmnScriptServices(EmptyFileSystem);
  parse = parseHelper<Model>(services.BpmnScript);
  validate = validationHelper<Model>(services.BpmnScript);
  exampleSrc = readFileSync(EXAMPLE_PATH, 'utf-8');
});

describe('the awaiting-confirmation deployable example', () => {
  it('opens validator-clean in the IDE', async () => {
    const { diagnostics } = await validate(exampleSrc);
    expect(diagnostics).toEqual([]);
  });

  it('desugars the await into an intermediateCatchEvent node carrying the message definition', async () => {
    const document = await parse(exampleSrc);
    expect(document.parseResult.parserErrors).toEqual([]);

    const ir = astToIr(document.parseResult.value);
    const catchNode = ir.flowElements.find(
      (el) => el.kind === 'intermediateCatchEvent',
    );

    expect(catchNode).toBeDefined();
    expect(catchNode).toMatchObject({
      kind: 'intermediateCatchEvent',
      eventDefinition: {
        kind: 'message',
        messageName: 'ConfirmationReceived',
      },
    });
  });
});
