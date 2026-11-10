// Drives the built out/server-worker.js over raw JSON-RPC in a worker thread,
// so run `npm run build` (or `npm run build:web`) before running this suite on
// its own. A small shim gives the bundle the `self` a browser worker has.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BUNDLE = fileURLToPath(
  new URL('../out/server-worker.js', import.meta.url),
);

const SHIM = `
const { parentPort } = require('node:worker_threads');
const listeners = { message: [], error: [] };
const self = {
  postMessage: (data) => parentPort.postMessage(data),
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  set onmessage(fn) { listeners.message = [fn]; },
};
globalThis.self = self;
parentPort.on('message', (data) => listeners.message.forEach((fn) => fn({ data })));
import(${JSON.stringify(pathToFileURL(BUNDLE).href)});
`;

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const read = (relative: string) =>
  readFileSync(`${REPO_ROOT}/${relative}`, 'utf8');

describe('server-worker.js bundle', () => {
  let worker: Worker;
  let nextId = 1;
  const pending = new Map<number, (message: Message) => void>();
  const notifications: Message[] = [];
  const notificationWaiters: (() => void)[] = [];

  function request<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result as T),
      );
      worker.postMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method: string, params: unknown): void {
    worker.postMessage({ jsonrpc: '2.0', method, params });
  }

  async function nextNotification(
    match: (message: Message) => boolean,
  ): Promise<Message> {
    for (;;) {
      const found = notifications.find(match);
      if (found) return found;
      await new Promise<void>((resolve) => notificationWaiters.push(resolve));
    }
  }

  beforeAll(async () => {
    if (!existsSync(BUNDLE)) {
      throw new Error(`${BUNDLE} is missing; run \`npm run build\` first.`);
    }
    worker = new Worker(SHIM, { eval: true });
    worker.on('error', (err) => {
      for (const settle of pending.values()) settle({ error: String(err) });
      pending.clear();
    });
    worker.on('message', (message: Message) => {
      if (message.id !== undefined && message.method === undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else if (message.method !== undefined && message.id === undefined) {
        notifications.push(message);
        notificationWaiters.splice(0).forEach((wake) => wake());
      } else if (message.id !== undefined) {
        // A server-to-client request such as client/registerCapability.
        worker.postMessage({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
  });

  afterAll(async () => {
    await worker?.terminate();
  });

  it('initialize reports completion and hover', async () => {
    const result = await request<{
      capabilities: { completionProvider?: unknown; hoverProvider?: unknown };
    }>('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    notify('initialized', {});

    expect(result.capabilities.completionProvider).toBeTruthy();
    expect(result.capabilities.hoverProvider).toBeTruthy();
  });

  it('publishes an error for an invalid script', async () => {
    const uri = 'file:///test/invalid.bpmnscript';
    notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'bpmn-script',
        version: 1,
        text: 'process broken {\n  start s\n  frobnicate\n}\n',
      },
    });

    const message = await nextNotification(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' &&
        (m.params as { uri: string }).uri === uri,
    );
    const diagnostics = (
      message.params as { diagnostics: { severity: number }[] }
    ).diagnostics;
    expect(diagnostics.filter((d) => d.severity === 1).length).toBeGreaterThan(
      0,
    );
  });

  it('completes user and service at a statement position', async () => {
    const uri = 'file:///test/complete.bpmnscript';
    notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'bpmn-script',
        version: 1,
        text: 'process p {\n  start s\n  \n}\n',
      },
    });

    const result = await request<
      { items: { label: string }[] } | { label: string }[]
    >('textDocument/completion', {
      textDocument: { uri },
      position: { line: 2, character: 2 },
    });
    const items = Array.isArray(result) ? result : result.items;
    const labels = items.map((item) => item.label);
    expect(labels).toContain('user');
    expect(labels).toContain('service');
  });

  it('compiles invoice-approval to BPMN XML', async () => {
    const result = await request<{ ok: boolean; output?: string }>(
      'bpmnscript/compile',
      {
        source: read(
          'examples/spring-boot/processes/invoice-approval.bpmnscript',
        ),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<bpmn:definitions');
    const { version } = JSON.parse(read('packages/web/package.json'));
    expect(result.output).toContain(`exporterVersion="${version}"`);
  });

  it('refuses to decompile a process that starts on an error', async () => {
    const result = await request<{ ok: boolean; kind?: string }>(
      'bpmnscript/decompile',
      { xml: read('tests/fixtures/error-start.bpmn') },
    );
    expect(result).toMatchObject({ ok: false, kind: 'unsupported' });
  });

  it('decompiles invoice-receipt with warnings', async () => {
    const result = await request<{
      ok: boolean;
      output?: string;
      warnings?: unknown[];
    }>('bpmnscript/decompile', {
      xml: read('tests/fixtures/invoice-receipt.bpmn'),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('process');
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('answers a malformed request with an error result, not a JSON-RPC error', async () => {
    const result = await request('bpmnscript/compile', {});
    expect(result).toMatchObject({ ok: false, kind: 'error' });
  });
});
