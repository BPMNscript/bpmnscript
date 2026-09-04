// `vscode` is injected by the extension host, not installed from npm, so it is
// mocked. The fake view exists to fire onDidDispose on demand.

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

// _buildHtml reads media/sidebar.html from this directory.
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

describe('SidebarViewProvider: dispose behavior', () => {
  it('refresh() after the view is disposed is a no-op instead of posting to a dead webview', async () => {
    const provider = new SidebarViewProvider({
      fsPath: EXTENSION_DIR,
    } as never);
    const { view, webview, fireDispose } = fakeWebviewView();

    provider.resolveWebviewView(view as never, {} as never, {} as never);

    await provider.refresh();
    expect(webview.postMessage).toHaveBeenCalledTimes(1);

    fireDispose();
    webview.postMessage.mockClear();

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(webview.postMessage).not.toHaveBeenCalled();
  });
});
