/**
 * Unit tests for the sidebar webview view provider's dispose behaviour.
 *
 * `vscode` is injected by the extension host at runtime, so it is mocked
 * with the minimal surface the provider touches. The webview view itself is
 * a hand-rolled fake so the test can fire its `onDidDispose` callback.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
      toString: () => `file://${path.join(base.fsPath, ...segments)}`,
    }),
  },
  window: {
    activeTextEditor: undefined,
  },
}));

import { SidebarViewProvider } from '../src/extension/sidebar-view-provider.js';

/** Root of packages/extension — media/sidebar.html is read from disk. */
const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function fakeWebviewView() {
  let disposeCallback: (() => void) | undefined;
  const webview = {
    options: undefined as unknown,
    html: '',
    cspSource: 'vscode-webview-resource:',
    asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    postMessage: vi.fn(),
  };
  const view = {
    webview,
    onDidDispose: (cb: () => void) => {
      disposeCallback = cb;
    },
  };
  return { view, webview, fireDispose: () => disposeCallback?.() };
}

describe('SidebarViewProvider — dispose behaviour', () => {
  it('refresh() after the view is disposed is a no-op instead of posting to a dead webview', async () => {
    const provider = new SidebarViewProvider({
      fsPath: EXTENSION_DIR,
    } as never);
    const { view, webview, fireDispose } = fakeWebviewView();

    provider.resolveWebviewView(view as never, {} as never, {} as never);

    // While the view is alive, refresh posts state to the webview.
    await provider.refresh();
    expect(webview.postMessage).toHaveBeenCalledTimes(1);

    fireDispose();
    webview.postMessage.mockClear();

    // After dispose, refresh must not touch the (now disposed) webview.
    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(webview.postMessage).not.toHaveBeenCalled();
  });
});
