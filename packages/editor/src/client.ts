// The BPMNscript language server in a web worker, with a Monaco language client on it.
// Browser-only (the language client has no server build).
import { MonacoLanguageClient } from 'monaco-languageclient';
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  CloseAction,
  ErrorAction,
} from 'vscode-languageclient/browser';
import { LANGUAGE_ID } from './language';
import { ensureMonacoApi, type MonacoOptions } from './monaco';
import {
  COMPILE_METHOD,
  DECOMPILE_METHOD,
  type CompileResult,
  type DecompileResult,
} from './protocol';

export type LspStatus = 'starting' | 'ready' | 'failed';

export type BpmnscriptClient = {
  readonly status: LspStatus;
  /** Called on every status change; returns an unsubscribe function. */
  onStatus(cb: (status: LspStatus) => void): () => void;
  compile(source: string): Promise<CompileResult>;
  decompile(xml: string): Promise<DecompileResult>;
  /** Drops the current worker and starts a fresh one. */
  restart(): void;
  dispose(): void;
};

export type ClientOptions = MonacoOptions & {
  /** URL of `server-worker.js` from `@bpmn-script/web`; add a version query so caches follow releases. */
  workerUrl: string;
};

const START_TIMEOUT = 10_000;
// A worker killed from outside sends no event; a request that never answers is how it shows.
const REQUEST_TIMEOUT = 10_000;

type Session = {
  worker: Worker;
  client: MonacoLanguageClient | null;
  dead: boolean;
};

/** Owns the BPMNscript worker and the language client on it; compile/decompile share the connection. */
export function createBpmnscriptClient({
  workerUrl,
  editorWorkerUrl,
}: ClientOptions): BpmnscriptClient {
  let status: LspStatus = 'starting';
  let session: Session | null = null;
  let disposed = false;
  const listeners = new Set<(s: LspStatus) => void>();
  // Rejecters of requests sent to the current worker, and of calls waiting for "ready".
  const inflight = new Set<(err: Error) => void>();
  const waiting = new Set<(err: Error) => void>();
  const rejectAll = (set: Set<(err: Error) => void>, reason: string) => {
    for (const reject of [...set]) reject(new Error(reason));
    set.clear();
  };

  const setStatus = (next: LspStatus) => {
    if (status === next) return;
    status = next;
    for (const cb of listeners) cb(next);
  };

  const kill = (s: Session) => {
    s.dead = true;
    s.client?.dispose(1000).catch(() => {});
    s.worker.terminate();
  };

  const fail = (s: Session, reason: string) => {
    if (s.dead) return;
    kill(s);
    if (session !== s) return;
    rejectAll(inflight, reason);
    setStatus('failed');
  };

  const start = () => {
    setStatus('starting');
    const worker = new Worker(workerUrl, {
      type: 'module',
      name: 'bpmnscript',
    });
    const s: Session = { worker, client: null, dead: false };
    session = s;
    worker.addEventListener('error', () =>
      fail(s, 'The BPMNscript worker failed.'),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      await ensureMonacoApi({ editorWorkerUrl });
      if (s.dead) return;
      // Counted from here, so a slow Monaco download does not count against the server.
      timer = setTimeout(
        () => fail(s, 'The language server did not answer initialize.'),
        START_TIMEOUT,
      );
      const client = new MonacoLanguageClient({
        name: 'BPMNscript',
        id: LANGUAGE_ID,
        clientOptions: {
          documentSelector: [{ language: LANGUAGE_ID }],
          errorHandler: {
            error: () => ({ action: ErrorAction.Continue }),
            closed: () => {
              fail(s, 'The language server connection closed.');
              return { action: CloseAction.DoNotRestart, handled: true };
            },
          },
        },
        messageTransports: {
          reader: new BrowserMessageReader(worker),
          writer: new BrowserMessageWriter(worker),
        },
      });
      s.client = client;
      await client.start();
      clearTimeout(timer);
      if (!s.dead) setStatus('ready');
    })().catch(() => {
      clearTimeout(timer);
      fail(s, 'The language server did not start.');
    });
  };

  const whenReady = (): Promise<MonacoLanguageClient> => {
    if (status === 'ready' && session?.client)
      return Promise.resolve(session.client);
    if (status === 'failed' || disposed)
      return Promise.reject(new Error('The language server is not running.'));
    return new Promise((resolve, reject) => {
      const off = () => {
        clearTimeout(timer);
        unsubscribe();
        waiting.delete(onFail);
      };
      const onFail = (err: Error) => {
        off();
        reject(err);
      };
      const timer = setTimeout(
        () => onFail(new Error('The language server did not become ready.')),
        START_TIMEOUT,
      );
      const unsubscribe = api_.onStatus((next) => {
        if (next === 'ready' && session?.client) {
          off();
          resolve(session.client);
        } else if (next === 'failed')
          onFail(new Error('The language server did not start.'));
      });
      waiting.add(onFail);
    });
  };

  const request = async <R>(method: string, params: unknown): Promise<R> => {
    const client = await whenReady();
    const s = session!;
    return new Promise<R>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        inflight.delete(reject);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`${method} did not answer.`));
        fail(s, `${method} did not answer.`);
      }, REQUEST_TIMEOUT);
      inflight.add(reject);
      client.sendRequest<R>(method, params).then(
        (r) => {
          done();
          resolve(r);
        },
        (e: unknown) => {
          done();
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  };

  const api_: BpmnscriptClient = {
    get status() {
      return status;
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    compile: (source) => request<CompileResult>(COMPILE_METHOD, { source }),
    decompile: (xml) => request<DecompileResult>(DECOMPILE_METHOD, { xml }),
    restart() {
      if (disposed) return;
      if (session) kill(session);
      rejectAll(inflight, 'The language server restarted.');
      start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (session) kill(session);
      session = null;
      rejectAll(inflight, 'The client was disposed.');
      rejectAll(waiting, 'The client was disposed.');
      listeners.clear();
    },
  };

  start();
  return api_;
}
