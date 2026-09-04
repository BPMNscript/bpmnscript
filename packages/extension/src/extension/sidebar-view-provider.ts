import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { swapExtension } from './conversion-core.js';

// Types shared between host and webview (duplicated in sidebar.js as JSDoc).

interface Counterpart {
  uri: string;
  name: string;
}

interface ActiveFile {
  uri: string;
  name: string;
  kind: 'dsl' | 'bpmn' | null;
  counterpart: Counterpart | null;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  // Must match the view id contributed in package.json.
  static readonly viewType = 'bpmnscript.sidebar';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // retainContextWhenHidden is false, so the view is rebuilt on every show.
    // Without collecting the disposable the listeners pile up.
    const disposables: vscode.Disposable[] = [];
    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => void this._handleMessage(message),
      undefined,
      disposables,
    );
    webviewView.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      // A later refresh() must be a no-op, not a post to a disposed webview.
      this._view = undefined;
    });
  }

  async refresh(): Promise<void> {
    if (!this._view) return;
    await this._postState();
  }

  private async _handleMessage(message: unknown): Promise<void> {
    const msg = message as { type: string; uri?: string };

    switch (msg.type) {
      case 'ready':
        await this._postState();
        break;

      case 'compile':
        if (msg.uri) {
          await vscode.commands.executeCommand(
            'bpmnscript.compile',
            vscode.Uri.parse(msg.uri),
          );
        }
        break;

      case 'decompile':
        if (msg.uri) {
          await vscode.commands.executeCommand(
            'bpmnscript.decompile',
            vscode.Uri.parse(msg.uri),
          );
        }
        break;

      case 'open':
        if (msg.uri) {
          await vscode.window.showTextDocument(vscode.Uri.parse(msg.uri));
        }
        break;

      case 'pick':
        await vscode.commands.executeCommand('bpmnscript.openAndDecompile');
        break;
    }
  }

  private async _postState(): Promise<void> {
    if (!this._view) return;

    const editor = vscode.window.activeTextEditor;
    let activeFile: ActiveFile | null = null;

    if (editor) {
      const uri = editor.document.uri;
      const ext = path.extname(uri.fsPath).toLowerCase();
      const kind: 'dsl' | 'bpmn' | null =
        ext === '.bpmnscript' ? 'dsl' : ext === '.bpmn' ? 'bpmn' : null;

      activeFile = {
        uri: uri.toString(),
        name: path.basename(uri.fsPath),
        kind,
        counterpart: kind ? await this._findCounterpart(uri, kind) : null,
      };
    }

    void this._view.webview.postMessage({ type: 'state', activeFile });
  }

  private async _findCounterpart(
    uri: vscode.Uri,
    kind: 'dsl' | 'bpmn',
  ): Promise<Counterpart | null> {
    const otherExt = kind === 'dsl' ? '.bpmn' : '.bpmnscript';
    const otherPath = swapExtension(uri.fsPath, otherExt);
    const otherUri = vscode.Uri.file(otherPath);
    try {
      await vscode.workspace.fs.stat(otherUri);
      return { uri: otherUri.toString(), name: path.basename(otherPath) };
    } catch {
      return null;
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const cspSource = webview.cspSource;

    const cssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'),
      )
      .toString();
    const jsUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'),
      )
      .toString();

    const templatePath = vscode.Uri.joinPath(
      this._extensionUri,
      'media',
      'sidebar.html',
    ).fsPath;
    let html = fs.readFileSync(templatePath, 'utf-8');

    // replaceAll: {{NONCE}} and {{CSP_SOURCE}} each appear more than once.
    html = html
      .replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{CSP_SOURCE}}', cspSource)
      .replace('{{CSS_URI}}', cssUri)
      .replace('{{JS_URI}}', jsUri);

    return html;
  }
}
